// As Filed - the pure core, shared by the page, the build tools and the tests.
//
// Everything here works on the dataset alone: looking a figure up, working
// out a ratio from two figures, formatting, and WRITING THE INSIGHTS. A
// sentence is built from figures by a template, so its numbers cannot drift
// from the figures it cites - and the tests rebuild every sentence from the
// committed figures and compare. No forecast, no advice, no model.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AsFiledCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var METRICS = {
    revenue: 'Revenue', cost: 'Cost of revenue', gross: 'Gross profit', rd: 'Research and development',
    capex: 'Capital spending', inventory: 'Inventory',
    // Cash and capital return (kept in the company's second file, f/<ID>).
    ocf: 'Operating cash flow', sbc: 'Stock-based compensation', buybacks: 'Share repurchases', dividends: 'Dividends paid',
    cash: 'Cash and cash equivalents', sti: 'Short-term investments',
    debtLong: 'Long-term debt, beyond a year', debtCurrent: 'Debt due within a year', debtShort: 'Short-term borrowings', debtTotal: 'Long-term debt, with its current portion',
  };
  // Which figures live in f/<ID>.json rather than c/<ID>.json.
  var FIN = { ocf: 1, sbc: 1, buybacks: 1, dividends: 1, cash: 1, sti: 1, debtLong: 1, debtCurrent: 1, debtShort: 1, debtTotal: 1 };
  function isFin(f) { return Boolean(FIN[f.m]); }
  var short = function (tag) { return String(tag).replace(/^.*:/, ''); };
  var SYMBOL = { USD: '$', EUR: '€', TWD: 'NT$' };
  var TYPE_NAMES = {
    supplier: 'Supplier', customer: 'Customer', service: 'Service or platform provider',
    auditor: 'Auditor', partner: 'Partner', competitor: 'Competitor, as stated',
  };
  // Supply runs from -> to for these; the others have no direction.
  var DIRECTED = { supplier: true, customer: true, service: true, auditor: true };

  /** The fiscal year a period belongs to: the year it ends in, except that
   *  a 52/53-week year ending in the first week of January (Cadence's ended
   *  on 2016-01-02) belongs to the year before. */
  function fiscalYear(end) {
    var y = Number(String(end).slice(0, 4));
    return /^\d{4}-01-0[1-7]$/.test(end) ? y - 1 : y;
  }
  function fig(data, c, m, fy) { return data.figures[c + '.' + m + '.' + fy] || null; }
  function id(c, m, fy) { return c + '.' + m + '.' + fy; }
  function company(data, cid) {
    for (var i = 0; i < data.companies.length; i += 1) if (data.companies[i].id === cid) return data.companies[i];
    for (var j = 0; j < data.others.length; j += 1) if (data.others[j].id === cid) return data.others[j];
    // Companies looked up on request (the page only): never among the reviewed set.
    var x = data.lookups || [];
    for (var k = 0; k < x.length; k += 1) if (x[k].id === cid) return x[k];
    return null;
  }

  /** A number worked out from figures, with the figures it rests on. */
  function derived(data, c, name, fy) {
    var rev = fig(data, c, 'revenue', fy);
    var cost = fig(data, c, 'cost', fy);
    var out = null;
    if (name === 'gross') {
      var g = fig(data, c, 'gross', fy);
      if (g) out = { v: g.v, cites: [id(c, 'gross', fy)], how: 'gross profit as reported' };
      else if (rev && cost) out = { v: rev.v - cost.v, cites: [id(c, 'revenue', fy), id(c, 'cost', fy)], how: 'revenue less cost of revenue' };
    } else if (name === 'grossMargin') {
      var gp = derived(data, c, 'gross', fy);
      if (gp && rev && rev.v > 0) out = { v: gp.v / rev.v, cites: uniq(gp.cites.concat([id(c, 'revenue', fy)])), how: gp.how + ' ÷ revenue' };
    } else if (name === 'rdIntensity' || name === 'capexIntensity') {
      var m = name === 'rdIntensity' ? 'rd' : 'capex';
      var x = fig(data, c, m, fy);
      if (x && rev && rev.v > 0) out = { v: x.v / rev.v, cites: [id(c, m, fy), id(c, 'revenue', fy)], how: METRICS[m].toLowerCase() + ' ÷ revenue' };
    } else if (name === 'inventoryDays') {
      var inv = fig(data, c, 'inventory', fy);
      if (inv && cost && cost.v > 0) out = { v: (inv.v / cost.v) * 365, cites: [id(c, 'inventory', fy), id(c, 'cost', fy)], how: 'year-end inventory ÷ cost of revenue × 365' };
    }
    else if (name === 'fcf') {
      // A derived figure: both inputs are filed figures, and both are cited.
      var o = fig(data, c, 'ocf', fy); var k = fig(data, c, 'capex', fy);
      if (o && k) out = { v: o.v - k.v, cites: [id(c, 'ocf', fy), id(c, 'capex', fy)], how: 'operating cash flow less capital spending' };
    } else if (name === 'fcfMargin') {
      var fc = derived(data, c, 'fcf', fy);
      if (fc && rev && rev.v > 0) out = { v: fc.v / rev.v, cites: fc.cites.concat([id(c, 'revenue', fy)]), how: fc.how + ' ÷ revenue' };
    } else if (name === 'sbcShare') {
      var sb = fig(data, c, 'sbc', fy);
      if (sb && rev && rev.v > 0) out = { v: sb.v / rev.v, cites: [id(c, 'sbc', fy), id(c, 'revenue', fy)], how: 'stock-based compensation ÷ revenue' };
    } else if (name === 'returned') {
      var bb = fig(data, c, 'buybacks', fy); var dv = fig(data, c, 'dividends', fy);
      if (bb && dv) out = { v: bb.v + dv.v, cites: [id(c, 'buybacks', fy), id(c, 'dividends', fy)], how: 'share repurchases plus dividends paid' };
    } else if (name === 'debt') {
      // Debt, as tagged: the sum of the balance-sheet tags named in `how`,
      // and nothing else. A borrowing tagged another way is not in it.
      var dl = fig(data, c, 'debtLong', fy); var dc = fig(data, c, 'debtCurrent', fy); var ds = fig(data, c, 'debtShort', fy); var dt = fig(data, c, 'debtTotal', fy);
      var parts = [];
      if (dl) {
        parts.push(['debtLong', dl]);
        if (dc) parts.push(['debtCurrent', dc]);
        // DebtCurrent is all debt due within a year; any other current tag
        // is the current part of long-term debt, and short-term borrowings
        // are on top of it.
        if (ds && !(dc && dc.tag === 'us-gaap:DebtCurrent')) parts.push(['debtShort', ds]);
      } else if (dt) {
        parts.push(['debtTotal', dt]);
        if (ds && dt.tag === 'us-gaap:LongTermDebt') parts.push(['debtShort', ds]);
      } else if (ds) parts.push(['debtShort', ds]);
      if (parts.length) {
        out = {
          v: parts.reduce(function (a, p) { return a + p[1].v; }, 0),
          cites: parts.map(function (p) { return id(c, p[0], fy); }),
          how: parts.map(function (p) { return short(p[1].tag); }).join(' + '),
        };
      }
    } else if (name === 'netDebt') {
      var de = derived(data, c, 'debt', fy); var ca = fig(data, c, 'cash', fy); var st = fig(data, c, 'sti', fy);
      if (de && ca) out = { v: de.v - ca.v - (st ? st.v : 0), cites: de.cites.concat([id(c, 'cash', fy)], st ? [id(c, 'sti', fy)] : []), how: 'debt as tagged less cash and cash equivalents' + (st ? ' and short-term investments' : '') };
    }
    return out;
  }
  function uniq(a) { var s = {}; var o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }

  function trim(n, d) { return n.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'); }
  /** "$416.2 billion", "€32.7 billion", "NT$3.81 trillion". */
  function money(v, cur, short) {
    var s = SYMBOL[cur] || (cur ? cur + ' ' : '');
    var a = Math.abs(v);
    var sign = v < 0 ? '-' : '';
    var unit; var n;
    if (a >= 1e12) { n = trim(a / 1e12, 2); unit = short ? 'T' : ' trillion'; } else if (a >= 1e9) { n = trim(a / 1e9, a >= 1e11 ? 0 : 1); unit = short ? 'B' : ' billion'; } else if (a >= 1e6) { n = trim(a / 1e6, a >= 1e8 ? 0 : 1); unit = short ? 'M' : ' million'; } else { n = String(Math.round(a)); unit = ''; }
    return sign + s + n + unit;
  }
  function pct(v, d) { return trim(v * 100, d === undefined ? 1 : d) + '%'; }
  /** A share for a sentence: one decimal, and never a bare "0%" for a share that is not zero. */
  function share(v) { return v > 0 && v < 0.0005 ? 'under 0.1%' : pct(v); }
  function times(v) { return trim(v, v >= 10 ? 0 : 1); }

  var pad10 = function (cik) { return ('0000000000' + cik).slice(-10); };
  function filingUrl(cik, accn) { return 'https://www.sec.gov/Archives/edgar/data/' + Number(cik) + '/' + String(accn).replace(/-/g, '') + '/' + accn + '-index.htm'; }
  /** Where a figure came from: form, fiscal period, accession number, link. */
  function figureSource(data, fid) {
    var f = data.figures[fid];
    if (!f) return null;
    var co = company(data, f.c);
    var filing = data.filings[f.a] || {};
    return {
      id: fid, company: co ? co.name : f.c, label: f.tag, fy: f.fy, end: f.end, value: f.v, unit: f.u,
      form: filing.form || '', filed: filing.filed || '', accn: f.a, url: filingUrl(filing.cik || co.cik, f.a), cik: filing.cik || co.cik,
      // Filed under an earlier registrant (a re-domicile): which one.
      prior: filing.cik && co.prior ? co.prior.filter(function (p) { return p.cik === filing.cik; })[0] || null : null,
    };
  }
  /** A link that opens the source at the quote where the browser supports
   *  text fragments; everywhere else it simply opens the document. */
  function quoteUrl(edge) {
    if (!/\.htm$/.test(edge.url)) return edge.url;
    var words = edge.quote.split(' ').slice(0, 6).join(' ');
    return edge.url + '#:~:text=' + encodeURIComponent(words).replace(/-/g, '%2D');
  }

  /* ---------------- the insights ---------------- */

  function S(topic, text, cites) { return { topic: topic, text: text, cites: uniq(cites) }; }

  function companyInsights(data, c) {
    var out = [];
    var cur = c.currency;
    var L = c.latest;
    var first = c.years[0];
    var M = function (v) { return money(v, cur); };
    var rev = fig(data, c.id, 'revenue', L);
    var prev = fig(data, c.id, 'revenue', L - 1);
    var rev0 = fig(data, c.id, 'revenue', first);
    if (rev && prev && prev.v > 0) {
      var ch = rev.v / prev.v - 1;
      var t = 'Revenue was ' + M(rev.v) + ' in FY' + L + ', ' + (ch >= 0 ? 'up ' : 'down ') + pct(Math.abs(ch)) + ' from FY' + (L - 1) + '.';
      var cites = [id(c.id, 'revenue', L), id(c.id, 'revenue', L - 1)];
      if (rev0 && first < L - 1 && rev0.v > 0) {
        t += ' In FY' + first + ' it was ' + M(rev0.v) + (rev.v >= rev0.v ? ': the FY' + L + ' figure is ' + times(rev.v / rev0.v) + ' times that.' : '.');
        cites.push(id(c.id, 'revenue', first));
      }
      out.push(S('revenue', t, cites));
    }
    var span = function (name) {
      var rows = [];
      c.years.forEach(function (fy) { var d = derived(data, c.id, name, fy); if (d) rows.push({ fy: fy, d: d }); });
      return rows;
    };
    var earlier = function (rows) { for (var i = 0; i < rows.length; i += 1) if (rows[i].fy === L - 5) return rows[i]; return null; };
    var last = function (rows) { return rows.length && rows[rows.length - 1].fy === L ? rows[rows.length - 1] : null; };
    var top = function (rows) { return rows.reduce(function (a, b) { return b.d.v > a.d.v ? b : a; }); };

    var gm = span('grossMargin');
    if (last(gm)) {
      var g = last(gm); var g5 = earlier(gm); var gt = top(gm);
      var s = 'Gross margin was ' + pct(g.d.v) + ' in FY' + L + ' (' + g.d.how + ')';
      var gc = g.d.cites.slice();
      if (g5) { s += ', against ' + pct(g5.d.v) + ' in FY' + g5.fy; gc = gc.concat(g5.d.cites); }
      s += '.';
      if (gt.fy !== L) { s += ' The highest in the years shown was ' + pct(gt.d.v) + ', in FY' + gt.fy + '.'; gc = gc.concat(gt.d.cites); } else if (gm.length > 2) s += ' That is the highest in the years shown.';
      if (gt.fy === L && gm.length > 2) gm.forEach(function (r) { gc = gc.concat(r.d.cites); });
      out.push(S('margin', s, gc));
    }
    var rd = span('rdIntensity');
    if (last(rd)) {
      var r = last(rd); var r5 = earlier(rd);
      var rs = 'Research and development took ' + pct(r.d.v) + ' of revenue in FY' + L + ' (' + M(fig(data, c.id, 'rd', L).v) + ')';
      var rc = r.d.cites.slice();
      if (r5) { rs += ', against ' + pct(r5.d.v) + ' in FY' + r5.fy; rc = rc.concat(r5.d.cites); }
      out.push(S('rd', rs + '.', rc));
    }
    var cx = span('capexIntensity');
    if (last(cx)) {
      var x = last(cx); var x5 = earlier(cx);
      var xs = 'Capital spending was ' + M(fig(data, c.id, 'capex', L).v) + ' in FY' + L + ', ' + pct(x.d.v) + ' of revenue';
      var xc = x.d.cites.slice();
      if (x5) { xs += '; in FY' + x5.fy + ' it was ' + M(fig(data, c.id, 'capex', x5.fy).v) + ', ' + pct(x5.d.v); xc = xc.concat(x5.d.cites); }
      out.push(S('capex', xs + '.', xc));
    }
    var inv = span('inventoryDays');
    if (last(inv)) {
      var v = last(inv); var vt = top(inv);
      var vs = 'Inventory at the end of FY' + L + ' was ' + M(fig(data, c.id, 'inventory', L).v) + ', about ' + Math.round(v.d.v) + ' days of cost of revenue.';
      var vc = v.d.cites.slice();
      if (vt.fy !== L) { vs += ' The most in the years shown was about ' + Math.round(vt.d.v) + ' days, at the end of FY' + vt.fy + '.'; vc = vc.concat(vt.d.cites); }
      out.push(S('inventory', vs, vc));
    }
    (data.mixes[c.id] || []).forEach(function (mix) {
      var j = mix.years.indexOf(L);
      if (j < 0 || !rev) return;
      var p = mix.parts[0];
      if (!p || p.vals[j] === null) return;
      var what = mix.kind === 'segment' ? 'segment' : mix.kind === 'geography' ? 'region' : 'product line or market';
      out.push(S('mix', 'The largest ' + what + ' in FY' + L + ' was ' + p.label + ': ' + M(p.vals[j]) + ', ' + pct(p.vals[j] / rev.v, 0) + ' of revenue.', [c.id + '.mix.' + mix.kind + '.' + L + '.0', id(c.id, 'revenue', L)]));
    });
    var conc = (data.concentration[c.id] || []).filter(function (k) { return k.fy === L; }).slice(0, 3);
    conc.forEach(function (k) {
      out.push(S('customers', 'The FY' + L + ' report tags the ' + (k.group ? 'group' : 'customer') + ' it labels “' + k.label + '” at ' + pct(k.pct, 0) + ' of revenue' + (k.within ? ' (within ' + k.within + ')' : '') + (k.derived ? ', taking the tagged amount as a share of total revenue' : '') + '.', [k.id]));
    });
    return out;
  }

  var COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  function computedFrom(n) { return 'computed from ' + (COUNT[n] || n) + ' filed figures'; }

  /* ---------------- cash, capital return, cash and debt ----------------
   * Sentences for the second half of a company's page, written the same
   * way: by a template, from figures, with the figures each rests on. */
  function finInsights(data, c) {
    var out = [];
    var cur = c.currency; var L = c.latest; var cid = c.id;
    var M = function (v) { return money(v, cur); };
    var at = function (name, fy) { return derived(data, cid, name, fy); };
    var has = function (fy) { return c.years.indexOf(fy) >= 0; };
    var fcf = at('fcf', L);
    if (fcf) {
      var t = 'Free cash flow was ' + M(fcf.v) + ' in FY' + L + ': operating cash flow of ' + M(fig(data, cid, 'ocf', L).v) + ' less capital spending of ' + M(fig(data, cid, 'capex', L).v) + ' (' + computedFrom(2) + ').';
      var cites = fcf.cites.slice();
      var fm = at('fcfMargin', L);
      if (fm) { t += ' That is ' + pct(fm.v) + ' of revenue.'; cites = cites.concat(fm.cites); }
      var f5 = has(L - 5) ? at('fcf', L - 5) : null;
      if (f5) { t += ' In FY' + (L - 5) + ' it was ' + M(f5.v) + '.'; cites = cites.concat(f5.cites); }
      out.push(S('fcf', t, cites));
    }
    var sb = at('sbcShare', L);
    if (sb) {
      var st = 'Stock-based compensation was ' + M(fig(data, cid, 'sbc', L).v) + ' in FY' + L + ', ' + share(sb.v) + ' of revenue';
      var sc = sb.cites.slice();
      var s5 = has(L - 5) ? at('sbcShare', L - 5) : null;
      if (s5) { st += ', against ' + share(s5.v) + ' in FY' + (L - 5); sc = sc.concat(s5.cites); }
      out.push(S('sbc', st + '.', sc));
    }
    var bb = fig(data, cid, 'buybacks', L); var dv = fig(data, cid, 'dividends', L);
    if (bb || dv) {
      var rc = [].concat(bb ? [id(cid, 'buybacks', L)] : [], dv ? [id(cid, 'dividends', L)] : []);
      var paid = [].concat(bb && bb.v > 0 ? [M(bb.v) + ' to repurchase its own shares'] : [], dv && dv.v > 0 ? [M(dv.v) + ' in dividends'] : []);
      var rt = paid.length ? 'In FY' + L + ' the company paid ' + paid.join(' and ') + (paid.length === 2 ? ': ' + M(bb.v + dv.v) + ' together (' + computedFrom(2) + ').' : '.') : 'In FY' + L + ' the company paid nothing to repurchase shares or in dividends, as tagged.';
      if (paid.length === 1) rt += bb && bb.v > 0 ? (dv ? ' Dividends paid are tagged as zero.' : ' No dividend payment is tagged for the year.') : (bb ? ' Share repurchases are tagged as zero.' : ' No share repurchase is tagged for the year.');
      if (!paid.length && !(bb && dv)) rt = 'In FY' + L + ' ' + (bb ? 'share repurchases' : 'dividends paid') + ' are tagged as zero; ' + (bb ? 'no dividend payment' : 'no share repurchase') + ' is tagged for the year.';
      out.push(S('returns', rt, rc));
    }
    var ca = fig(data, cid, 'cash', L); var si = fig(data, cid, 'sti', L); var de = at('debt', L);
    if (ca) {
      var dt = 'At the end of FY' + L + ' the balance sheet carried ' + M(ca.v) + ' in cash and cash equivalents' + (si ? ' and ' + M(si.v) + ' in short-term investments' : '');
      var dc = [id(cid, 'cash', L)].concat(si ? [id(cid, 'sti', L)] : []);
      if (de) {
        dt += ', and ' + M(de.v) + ' of debt as tagged (' + de.how + ').';
        dc = dc.concat(de.cites);
        var nd = at('netDebt', L);
        dt += nd.v >= 0 ? ' Debt less cash' + (si ? ' and short-term investments' : '') + ' was ' + M(nd.v) : ' Cash' + (si ? ' and short-term investments' : '') + ' exceeded that debt by ' + M(-nd.v);
        dt += ' (' + computedFrom(nd.cites.length) + ').';
      } else dt += '. No debt is tagged under the tags read here.';
      out.push(S('debt', dt, dc));
    }
    return out;
  }

  function nameOf(data, cid) { var c = company(data, cid); return c ? c.name : cid; }
  function list(items) { return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]; }

  function patterns(data) {
    var out = [];
    var filers = data.companies;
    var layerName = {}; data.layers.forEach(function (l) { layerName[l.id] = l.name; });

    /* 1. Inventory days, company by company, year by year. */
    var maxFy = Math.max.apply(null, filers.map(function (c) { return c.latest; }));
    var years = []; for (var y = maxFy - 8; y <= maxFy; y += 1) years.push(y);
    var rows = [];
    filers.forEach(function (c) {
      var cells = years.map(function (fy) { var d = derived(data, c.id, 'inventoryDays', fy); return d ? { fy: fy, v: d.v, cites: d.cites } : null; });
      if (cells.filter(Boolean).length >= 5) rows.push({ c: c.id, layer: c.layer, cells: cells });
    });
    var order = {}; data.layers.forEach(function (l, i) { order[l.id] = i; });
    rows.sort(function (a, b) { return order[a.layer] - order[b.layer]; });
    var sent = [];
    // Per layer, the three companies whose most inventory (in days) was the
    // highest; every company's own peak is in its row of the table.
    data.layers.forEach(function (l) {
      var peaks = rows.filter(function (r) { return r.layer === l.id; }).map(function (r) {
        return { c: r.c, p: r.cells.filter(Boolean).reduce(function (a, b) { return b.v > a.v ? b : a; }) };
      }).sort(function (a, b) { return b.p.v - a.p.v; });
      if (peaks.length < 2) return;
      var top3 = peaks.slice(0, 3);
      var cites = []; top3.forEach(function (x) { cites = cites.concat(x.p.cites); });
      sent.push(S('inventory', layerName[l.id] + ': of ' + peaks.length + ' companies, the most inventory any held at a year end in these years, in days of cost of revenue, was at ' + list(top3.map(function (x) { return nameOf(data, x.c) + ' (about ' + Math.round(x.p.v) + ' days, FY' + x.p.fy + ')'; })) + '.', cites));
    });
    out.push({
      id: 'inventory', title: 'Inventory moves through the chain',
      lede: 'How many days of cost of revenue each company was holding in inventory at its year end. Read down a column to compare one year across the chain; read along a row to see one company build up and work down.',
      method: 'Inventory days = year-end inventory ÷ cost of revenue × 365, both as reported. Fiscal years end in different months, so a column is a fiscal-year label, not a calendar year. Companies with no tagged inventory are left out.',
      chart: { type: 'heat', years: years, rows: rows }, sentences: sent,
    });

    /* 2. R&D against gross margin, latest fiscal year. */
    var pts = [];
    filers.forEach(function (c) {
      var a = derived(data, c.id, 'rdIntensity', c.latest); var b = derived(data, c.id, 'grossMargin', c.latest);
      if (a && b) pts.push({ c: c.id, layer: c.layer, fy: c.latest, x: a.v, y: b.v, cites: uniq(a.cites.concat(b.cites)) });
    });
    var byX = pts.slice().sort(function (a, b) { return b.x - a.x; });
    var byY = pts.slice().sort(function (a, b) { return b.y - a.y; });
    var s2 = [];
    if (pts.length >= 4) {
      var tag = function (p, k) { return nameOf(data, p.c) + ' (' + pct(p[k], 0) + ', FY' + p.fy + ')'; };
      s2.push(S('rd', 'The largest shares of revenue going to research and development were at ' + list(byX.slice(0, 3).map(function (p) { return tag(p, 'x'); })) + '; the smallest at ' + list(byX.slice(-3).reverse().map(function (p) { return tag(p, 'x'); })) + '.', [].concat.apply([], byX.slice(0, 3).concat(byX.slice(-3)).map(function (p) { return p.cites; }))));
      s2.push(S('margin', 'Gross margin ran from ' + tag(byY[byY.length - 1], 'y') + ' to ' + tag(byY[0], 'y') + '.', byY[0].cites.concat(byY[byY.length - 1].cites)));
    }
    out.push({
      id: 'rd-margin', title: 'R&D against gross margin',
      lede: 'Each company in its latest fiscal year: the share of revenue spent on research and development, against the share kept after cost of revenue.',
      method: 'R&D intensity = research and development expense ÷ revenue. Gross margin = gross profit ÷ revenue (revenue less cost of revenue where gross profit is not tagged). Companies that do not tag an R&D line are left out.',
      chart: { type: 'scatter', points: pts }, sentences: s2,
    });

    /* 3. Capital spending waves, in US dollars as each company reports. */
    var groups = [
      { name: 'Cloud capital spending', who: ['MSFT', 'GOOGL', 'AMZN', 'META'], m: 'capex' },
      { name: 'Chip makers’ capital spending', who: ['INTC', 'MU', 'TXN', 'TSM'], m: 'capex' },
      { name: 'Equipment makers’ revenue', who: ['AMAT', 'LRCX', 'KLAC'], m: 'revenue' },
    ];
    var series = []; var s3 = [];
    groups.forEach(function (g) {
      var points = [];
      for (var fy = maxFy - 9; fy <= maxFy; fy += 1) {
        var sum = 0; var cites = []; var ok = true;
        g.who.forEach(function (cid) {
          var co = company(data, cid);
          var m = co.currency === 'USD' ? g.m : g.m + 'Usd';
          var f = fig(data, cid, m, fy);
          if (!f) { ok = false; return; }
          sum += f.v; cites.push(id(cid, m, fy));
        });
        if (ok) points.push({ fy: fy, v: sum, cites: cites });
      }
      if (points.length < 3) return;
      series.push({ name: g.name, who: g.who, points: points });
      var a = points[0]; var b = points[points.length - 1];
      s3.push(S('capex', g.name + ' (' + list(g.who.map(function (w) { return nameOf(data, w); })) + ') added up to ' + money(b.v, 'USD') + ' in FY' + b.fy + ', against ' + money(a.v, 'USD') + ' in FY' + a.fy + (b.v > a.v ? ': ' + times(b.v / a.v) + ' times as much.' : '.'), a.cites.concat(b.cites)));
    });
    out.push({
      id: 'capex', title: 'Capital spending waves',
      lede: 'What four cloud companies and four chip makers spent on property and equipment, beside what three equipment makers took in as revenue.',
      method: 'Sums of each company’s own reported figure for its own fiscal year; fiscal years end in different months. TSMC’s figure is its own US-dollar translation, tagged in its 20-F. ASML reports in euros and is not in the equipment sum. A year appears only when every company in the group has a figure for it.',
      chart: { type: 'lines', unit: 'USD', series: series }, sentences: s3,
    });

    /* 4. Dependence on a few customers. */
    var bars = []; var s4 = [];
    filers.forEach(function (c) {
      var ks = (data.concentration[c.id] || []).filter(function (k) { return k.fy === c.latest; });
      if (!ks.length) return;
      var k = ks[0];
      var named = data.edges.filter(function (e) { return e.fig && data.figures[e.fig] && data.figures[e.fig].c === c.id; });
      bars.push({ c: c.id, layer: c.layer, fy: k.fy, label: k.label, v: k.pct, cite: k.id, group: Boolean(k.group), all: ks.map(function (z) { return { label: z.label, v: z.pct, cite: z.id }; }), named: named.length > 0 });
    });
    bars.sort(function (a, b) { return b.v - a.v; });
    bars.slice(0, 6).forEach(function (b) {
      s4.push(S('customers', nameOf(data, b.c) + ': the ' + (b.group ? 'group' : 'customer') + ' its FY' + b.fy + ' report labels “' + b.label + '” was ' + pct(b.v, 0) + ' of revenue.', [b.cite]));
    });
    out.push({
      id: 'customers', title: 'Dependence on a few customers',
      lede: 'The largest single customer each company tags in its latest annual report, as a share of revenue - or the group of customers, where a report tags only a group. Most reports do not name the customer; the label shown is the report’s own.',
      method: 'From the customer-concentration figures tagged in each report’s XBRL data (share of revenue, not of receivables). TSMC tags an amount per major customer; its share is that amount ÷ revenue. A company with no bar tags no single customer’s share of revenue.',
      chart: { type: 'bars', rows: bars }, sentences: s4,
    });
    return out;
  }

  function writeAll(data) {
    var insights = {};
    var fin = {};
    data.companies.forEach(function (c) { insights[c.id] = companyInsights(data, c); fin[c.id] = finInsights(data, c); });
    return { insights: insights, patterns: patterns(data), finsights: fin };
  }

  /** JSON with every object's keys in sorted order, so a hash does not
   *  depend on the order parts were loaded and merged in. */
  function canonical(x) {
    if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
    if (x && typeof x === 'object') return '{' + Object.keys(x).sort().filter(function (k) { return x[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canonical(x[k]); }).join(',') + '}';
    return JSON.stringify(x);
  }
  /** One hash over everything a reader is shown as fact. */
  function integrity(data, sha) {
    return sha(canonical([data.figures, data.edges, data.insights, data.patterns, data.mixes, data.concentration, data.finsights, data.fin]));
  }

  /* ---------------- the published files ----------------
   * The dataset is published in parts, so a phone's first load is small:
   *   data/index.json     companies (with their headline figures), the
   *                       stated relationships and their sources
   *   data/patterns.json  the cross-company patterns and the figures they cite
   *   data/c/<ID>.json    one company's figures, revenue mix, customer
   *                       concentration and insight sentences
   *   data/f/<ID>.json    the same company's cash, quarterly, forward-looking,
   *                       pay, insider and risk-factor data, with its sentences
   * The page loads index.json first and the others when a view needs them,
   * merging each into one object the functions above read. */
  var PART = /^(index|patterns|[cf]\/[A-Z]{1,6})$/;
  function partPath(part) {
    if (!PART.test(String(part))) throw new Error('not a data part: ' + part);
    return 'data/' + part + '.json';
  }
  function pick(data, ids) {
    var figures = {}; var filings = {};
    ids.forEach(function (fid) {
      var f = data.figures[fid];
      if (!f) return;
      figures[fid] = f;
      if (data.filings[f.a]) filings[f.a] = data.filings[f.a];
    });
    return { figures: figures, filings: filings };
  }
  function chartCites(p) {
    var out = [];
    var c = p.chart;
    if (c.type === 'heat') c.rows.forEach(function (r) { r.cells.forEach(function (x) { if (x) out = out.concat(x.cites); }); });
    if (c.type === 'scatter') c.points.forEach(function (q) { out = out.concat(q.cites); });
    if (c.type === 'lines') c.series.forEach(function (x) { x.points.forEach(function (q) { out = out.concat(q.cites); }); });
    if (c.type === 'bars') c.rows.forEach(function (r) { out.push(r.cite); r.all.forEach(function (z) { out.push(z.cite); }); });
    p.sentences.forEach(function (st) { out = out.concat(st.cites); });
    return out;
  }
  /** The headline figures a company's row and map circle show. */
  function headIds(c) {
    return ['revenue', 'revenueUsd', 'gross', 'cost'].map(function (m) { return id(c.id, m, c.latest); });
  }
  /** A whole dataset -> its published parts. */
  function split(data) {
    var head = [];
    data.companies.forEach(function (c) { head = head.concat(headIds(c)); });
    data.edges.forEach(function (e) { if (e.fig) head.push(e.fig); });
    var hp = pick(data, head);
    var index = {
      app: data.app, schema: 2, built: data.built, disclaimer: data.disclaimer, layers: data.layers,
      companies: data.companies.map(function (c) {
        var o = {}; Object.keys(c).forEach(function (k) { o[k] = c[k]; });
        o.spark = c.years.map(function (fy) { var f = fig(data, c.id, 'revenue', fy); return f ? f.v : null; });
        return o;
      }),
      // An edge's link is its source's link: not repeated per edge here
      // (start() puts it back).
      others: data.others, sources: data.sources,
      edges: data.edges.map(function (e) { var o = {}; Object.keys(e).forEach(function (k) { if (k !== 'url') o[k] = e[k]; }); return o; }),
      figures: hp.figures, filings: hp.filings,
      counts: { figures: Object.keys(data.figures).length, filings: Object.keys(data.filings).length, sources: Object.keys(data.sources).length },
      integrity: data.integrity,
    };
    var pc = [];
    data.patterns.forEach(function (p) { pc = pc.concat(chartCites(p)); });
    var pp = pick(data, pc);
    var patternsPart = { part: 'patterns', patterns: data.patterns, figures: pp.figures, filings: pp.filings };
    var companies = {}; var fins = {};
    data.companies.forEach(function (c) {
      var all = Object.keys(data.figures).filter(function (k) { return data.figures[k].c === c.id; });
      var cp = pick(data, all.filter(function (k) { return !isFin(data.figures[k]); }));
      var fp = pick(data, all.filter(function (k) { return isFin(data.figures[k]); }));
      var one = function (o, d) { var x = {}; x[c.id] = (o || {})[c.id] || d; return x; };
      companies[c.id] = { part: 'c/' + c.id, id: c.id, figures: cp.figures, filings: cp.filings, mixes: one(data.mixes, []), concentration: one(data.concentration, []), insights: one(data.insights, []) };
      fins[c.id] = { part: 'f/' + c.id, id: c.id, figures: fp.figures, filings: fp.filings, finsights: one(data.finsights, []), fin: one(data.fin, {}) };
    });
    return { index: index, patterns: patternsPart, companies: companies, fins: fins };
  }
  /** The index as the page starts from it, ready for parts to merge into. */
  function start(index) {
    var d = {};
    Object.keys(index).forEach(function (k) { d[k] = index[k]; });
    d.figures = Object.assign({}, index.figures); d.filings = Object.assign({}, index.filings);
    d.edges = index.edges.map(function (e) { var o = {}; Object.keys(e).forEach(function (k) { o[k] = e[k]; }); o.url = index.sources[e.source].url; return o; });
    d.mixes = {}; d.concentration = {}; d.insights = {}; d.finsights = {}; d.fin = {}; d.patterns = d.patterns || null;
    return d;
  }
  /** Merge one loaded part into the page's dataset. */
  function merge(d, part) {
    Object.assign(d.figures, part.figures || {});
    Object.assign(d.filings, part.filings || {});
    ['mixes', 'concentration', 'insights', 'finsights', 'fin'].forEach(function (k) { if (part[k]) Object.assign(d[k], part[k]); });
    if (part.patterns) d.patterns = part.patterns;
    return d;
  }

  return {
    METRICS: METRICS, TYPE_NAMES: TYPE_NAMES, DIRECTED: DIRECTED, SYMBOL: SYMBOL,
    fiscalYear: fiscalYear, fig: fig, derived: derived, company: company, money: money, pct: pct, times: times,
    filingUrl: filingUrl, figureSource: figureSource, quoteUrl: quoteUrl, pad10: pad10,
    companyInsights: companyInsights, finInsights: finInsights, isFin: isFin, computedFrom: computedFrom, patterns: patterns, writeAll: writeAll, integrity: integrity, canonical: canonical,
    partPath: partPath, split: split, start: start, merge: merge, headIds: headIds,
  };
}));
