// As Filed - the page. It draws what is in data/dataset.json and nothing
// else: no model, no request to any other origin (links open the sources).
// Everything is built with createElement/textContent; no inline script, no
// handlers in markup, no style attributes (sizes are SVG attributes, colour
// and state are classes).

(function () {
  'use strict';
  var Core = window.AsFiledCore;
  var BASE = location.pathname.replace(/[^/]*$/, '');
  var SVG = 'http://www.w3.org/2000/svg';
  var main = document.getElementById('main');
  var sheet = document.getElementById('sheet');
  var data = null;
  var lastWidth = 0;
  var mapState = { types: { supplier: true, customer: true, service: true, partner: true, investor: true, competitor: false }, layers: { equipment: true, chips: true, devices: true, cloud: true }, focus: null, view: 'map' };

  function h(tag, attrs) {
    var el = document.createElement(tag);
    apply(el, attrs);
    for (var i = 2; i < arguments.length; i += 1) add(el, arguments[i]);
    return el;
  }
  function s(tag, attrs) {
    var el = document.createElementNS(SVG, tag);
    apply(el, attrs);
    for (var i = 2; i < arguments.length; i += 1) add(el, arguments[i]);
    return el;
  }
  function apply(el, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else el.setAttribute(k === 'cls' ? 'class' : k, v === true ? '' : String(v));
    });
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function r1(n) { return Math.round(n * 10) / 10; }
  function nameOf(id) { var c = Core.company(data, id); return c ? c.name : id; }
  function layerName(id) { for (var i = 0; i < data.layers.length; i += 1) if (data.layers[i].id === id) return data.layers[i].name; return id; }
  function safeUrl(u) { return /^https:\/\/(www\.sec\.gov|www\.apple\.com)\//.test(String(u)) ? u : null; }
  function ext(url, label) {
    var ok = safeUrl(url);
    return ok ? h('a', { href: ok, target: '_blank', rel: 'noopener noreferrer', cls: 'ext' }, label, h('span', { cls: 'sr', text: ' (opens the source in a new tab)' })) : h('span', { text: label });
  }

  /* ---------------- the sheet (sources, quotes) ---------------- */

  function openSheet(title, body) {
    document.getElementById('sheet-title').textContent = title;
    var b = document.getElementById('sheet-body');
    clear(b); add(b, body);
    if (!sheet.open) sheet.showModal();
    b.scrollTop = 0;
  }
  document.getElementById('sheet-close').addEventListener('click', function () { sheet.close(); });
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });

  function valueText(f) { return f.u === 'share' ? Core.pct(f.v, 1) : Core.money(f.v, f.u); }
  function figLabel(f) { return Core.METRICS[f.m] || (f.m === 'revenueUsd' ? 'Revenue (company’s own US-dollar translation)' : f.m === 'capexUsd' ? 'Capital spending (company’s own US-dollar translation)' : f.tag.charAt(0).toUpperCase() + f.tag.slice(1)); }
  function figureCard(fid) {
    var f = data.figures[fid];
    var src = Core.figureSource(data, fid);
    return h('div', { cls: 'src' },
      h('p', { cls: 'src-v' }, h('strong', { text: valueText(f) }), ' · ' + src.company + ' · FY' + f.fy),
      h('p', { cls: 'src-l', text: figLabel(f) + (Core.METRICS[f.m] || /Usd$/.test(f.m) ? ' (XBRL tag ' + f.tag + ')' : '') }),
      h('dl', { cls: 'kv' },
        h('dt', { text: 'Filing' }), h('dd', { text: 'Form ' + src.form + ', filed ' + src.filed }),
        h('dt', { text: 'Period' }), h('dd', { text: 'Fiscal year ended ' + f.end }),
        h('dt', { text: 'Accession no.' }), h('dd', { text: src.accn })),
      h('p', null, ext(src.url, 'Open this filing on sec.gov')));
  }
  function edgeCard(e) {
    var src = data.sources[e.source];
    var fig = e.fig ? data.figures[e.fig] : null;
    return h('div', { cls: 'src' },
      h('p', { cls: 'badge t-' + family(e.type), text: Core.TYPE_NAMES[e.type] }),
      h('p', { cls: 'src-l', text: e.gloss }),
      h('blockquote', null, e.lead ? h('span', { cls: 'lead', text: e.lead + ' … ' }) : null, '“' + e.quote + '”'),
      fig ? h('p', { cls: 'src-l', text: 'Tagged beside that label: ' + Core.pct(fig.v, 0) + ' of revenue, FY' + fig.fy + '.' }) : null,
      h('dl', { cls: 'kv' },
        h('dt', { text: 'Who said it' }), h('dd', { text: nameOf(e.by) }),
        h('dt', { text: 'Document' }), h('dd', { text: src.title }),
        h('dt', { text: 'Section' }), h('dd', { text: e.section }),
        h('dt', { text: src.kind === 'supplier-list' ? 'PDF dated' : 'Filed' }), h('dd', { text: e.date })),
      h('p', null, ext(src.kind === 'xbrl' ? e.url : Core.quoteUrl(e), src.kind === 'supplier-list' ? 'Open the list on apple.com' : 'Open the source on sec.gov')));
  }
  function showCites(title, cites) {
    openSheet(title, cites.map(function (id) {
      if (data.figures[id]) return figureCard(id);
      var e = data.edges.filter(function (x) { return x.id === id; })[0];
      return e ? edgeCard(e) : null;
    }));
  }
  function sentence(st) {
    return h('p', { cls: 'say' }, st.text + ' ',
      h('button', { type: 'button', cls: 'cite', 'aria-label': 'Sources for this sentence', on: { click: function () { showCites('Sources', st.cites); } } }, st.cites.length === 1 ? 'Source' : st.cites.length + ' sources'));
  }

  /* ---------------- charts ---------------- */

  function tip(svg) {
    var g = s('g', { cls: 'tip', 'aria-hidden': 'true' });
    var bg = s('rect', { rx: 6, height: 38 });
    var t1 = s('text', { cls: 'tip-a', x: 8, y: 15 });
    var t2 = s('text', { cls: 'tip-b', x: 8, y: 30 });
    g.appendChild(bg); g.appendChild(t1); g.appendChild(t2);
    svg.appendChild(g);
    return {
      show: function (x, y, a, b, W) {
        t1.textContent = a; t2.textContent = b;
        var w = Math.max(a.length * 6.4, b.length * 7.4) + 16;
        bg.setAttribute('width', w);
        var tx = Math.min(Math.max(x - w / 2, 2), W - w - 2);
        var ty = y - 48 < 2 ? y + 12 : y - 48;
        g.setAttribute('transform', 'translate(' + r1(tx) + ',' + r1(ty) + ')');
        g.classList.add('on');
      },
      hide: function () { g.classList.remove('on'); },
    };
  }
  function niceMax(v) { var p = Math.pow(10, Math.floor(Math.log10(v))); var m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }

  /** One measure for one company over its fiscal years: bars for amounts,
   *  a line for ratios. Each year is a button that opens its source. */
  function seriesChart(host, o) {
    var W = Math.max(280, host.clientWidth);
    var H = 190; var L = 46; var R = 12; var T = 12; var B = 24;
    var pts = o.points.filter(function (p) { return p.v !== null; });
    if (pts.length < 2) { host.appendChild(h('p', { cls: 'none', text: 'Not tagged in enough years to chart.' })); return; }
    var years = o.years;
    var max = niceMax(Math.max.apply(null, pts.map(function (p) { return p.v; })));
    var min = 0;
    if (o.kind === 'line') {
      var lo = Math.min.apply(null, pts.map(function (p) { return p.v; }));
      min = lo < 0 ? -niceMax(-lo) : 0;
    }
    var pw = W - L - R; var ph = H - T - B;
    var band = pw / years.length;
    var X = function (fy) { return L + band * (years.indexOf(fy) + 0.5); };
    var Y = function (v) { return T + ph - ((v - min) / (max - min)) * ph; };
    var svg = s('svg', { cls: 'chart', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': o.title + ' by fiscal year' });
    [0, 0.5, 1].forEach(function (k) {
      var v = min + (max - min) * k;
      svg.appendChild(s('line', { cls: 'grid', x1: L, x2: W - R, y1: r1(Y(v)), y2: r1(Y(v)) }));
      svg.appendChild(s('text', { cls: 'axis', x: L - 6, y: r1(Y(v)) + 4, 'text-anchor': 'end', text: o.tick(v) }));
    });
    var step = Math.ceil(years.length / Math.floor(pw / 34));
    years.forEach(function (fy, i) {
      if ((years.length - 1 - i) % step === 0) svg.appendChild(s('text', { cls: 'axis', x: r1(X(fy)), y: H - 6, 'text-anchor': 'middle', text: '’' + String(fy).slice(2) }));
    });
    if (o.kind === 'bar') {
      var bw = Math.min(band * 0.62, 26);
      pts.forEach(function (p) {
        var y = Y(Math.max(p.v, 0)); var hgt = Math.max(1, Math.abs(Y(p.v) - Y(0)));
        svg.appendChild(s('rect', { cls: 'bar' + (p.fy === years[years.length - 1] ? ' now' : ''), x: r1(X(p.fy) - bw / 2), y: r1(y), width: r1(bw), height: r1(hgt), rx: 3 }));
      });
    } else {
      var d = ''; var prev = null;
      pts.forEach(function (p) {
        d += (prev !== null && years.indexOf(p.fy) === years.indexOf(prev) + 1 ? 'L' : 'M') + r1(X(p.fy)) + ' ' + r1(Y(p.v));
        prev = p.fy;
      });
      svg.appendChild(s('path', { cls: 'line', d: d }));
      pts.forEach(function (p) { svg.appendChild(s('circle', { cls: 'dot', cx: r1(X(p.fy)), cy: r1(Y(p.v)), r: 3.5 })); });
    }
    var tp = tip(svg);
    pts.forEach(function (p) {
      var hit = s('rect', {
        cls: 'hit', x: r1(X(p.fy) - band / 2), y: T, width: r1(band), height: ph + B, tabindex: 0, role: 'button',
        'aria-label': 'FY' + p.fy + ': ' + o.fmt(p.v) + '. Open the source.',
      });
      var on = function () { tp.show(X(p.fy), Y(Math.max(p.v, 0)), 'FY' + p.fy, o.fmt(p.v), W); };
      hit.addEventListener('pointerenter', on); hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', tp.hide); hit.addEventListener('blur', tp.hide);
      var go = function () { showCites(o.title + ', FY' + p.fy, p.cites); };
      hit.addEventListener('click', go);
      hit.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      svg.insertBefore(hit, svg.lastChild);
    });
    host.appendChild(svg);
  }
  function tableOf(head, rows) {
    return h('details', { cls: 'tbl' }, h('summary', { text: 'Show as a table' }),
      h('div', { cls: 'scroll' }, h('table', null,
        h('thead', null, h('tr', null, head.map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', null, rows.map(function (r) { return h('tr', null, r.map(function (c, i) { return i === 0 ? h('th', { scope: 'row' }, c) : h('td', null, c); })); })))));
  }
  function srcButton(label, title, cites) {
    return h('button', { type: 'button', cls: 'cite', on: { click: function () { showCites(title, cites); } } }, label);
  }
  function barList(rows) {
    return h('ul', { cls: 'bars' }, rows.map(function (r) {
      var svg = s('svg', { cls: 'hbar', viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        s('rect', { cls: 'track', width: 100, height: 8, rx: 1 }),
        s('rect', { cls: 'fill', width: r1(Math.max(0.6, Math.min(1, r.share) * 100)), height: 8, rx: 1 }));
      return h('li', null,
        h('div', { cls: 'bar-top' }, h('span', { cls: 'bar-l' }, r.label, r.sub ? h('span', { cls: 'sub', text: ' ' + r.sub }) : null), h('span', { cls: 'bar-v', text: r.value })),
        svg,
        r.cites ? h('div', { cls: 'bar-src' }, srcButton('Source', r.label, r.cites)) : null);
    }));
  }

  /* ---------------- home ---------------- */

  function spark(c) {
    var vals = c.years.map(function (fy) { var f = Core.fig(data, c.id, 'revenue', fy); return f ? f.v : null; }).filter(function (v) { return v !== null; });
    if (vals.length < 3) return null;
    var max = Math.max.apply(null, vals);
    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + r1(2 + (i / (vals.length - 1)) * 60) + ' ' + r1(22 - (v / max) * 20); }).join('');
    return s('svg', { cls: 'spark', width: 64, height: 24, viewBox: '0 0 64 24', 'aria-hidden': 'true' }, s('path', { d: d }));
  }
  function home() {
    var nFig = Object.keys(data.figures).length;
    var page = h('div', { cls: 'page' },
      h('section', { cls: 'hero center' },
        h('p', { cls: 'eyebrow', text: 'From public filings' }),
        h('h1', { text: 'What the filings say.' }),
        h('p', { cls: 'lede', text: 'Nineteen big technology companies, in their own reported numbers and their own words. Every figure opens its filing. Every relationship shows the exact quote.' }),
        h('div', { cls: 'cta' }, h('a', { cls: 'pill', href: '#/map', text: 'Open the map' }), h('a', { cls: 'pill line', href: '#/patterns', text: 'See the patterns' })),
        h('ul', { cls: 'stats' },
          h('li', null, h('strong', { text: String(data.companies.length) }), 'companies'),
          h('li', null, h('strong', { text: nFig.toLocaleString('en-US') }), 'reported figures'),
          h('li', null, h('strong', { text: String(data.edges.length) }), 'quoted relationships'))));
    data.layers.slice().reverse().forEach(function (l) {
      var cs = data.companies.filter(function (c) { return c.layer === l.id; });
      page.appendChild(h('section', { cls: 'group' },
        h('h2', { text: l.name }), h('p', { cls: 'group-sub', text: l.blurb }),
        h('ul', { cls: 'rows card' }, cs.map(function (c) {
          var rev = Core.fig(data, c.id, 'revenue', c.latest);
          var gm = Core.derived(data, c.id, 'grossMargin', c.latest);
          return h('li', null, h('a', { href: '#/c/' + c.id, cls: 'row' },
            h('span', { cls: 'tile', 'aria-hidden': 'true', text: c.name.replace(/[^A-Za-z]/g, '').slice(0, 2) }),
            h('span', { cls: 'row-main' }, h('span', { cls: 'row-t', text: c.name }), h('span', { cls: 'row-s', text: 'FY' + c.latest + ' revenue ' + (rev ? Core.money(rev.v, c.currency) : 'n/a') + (gm ? ' · gross margin ' + Core.pct(gm.v, 0) : '') })),
            spark(c), h('span', { cls: 'chev', 'aria-hidden': 'true', text: '›' })));
        }))));
    });
    return page;
  }

  /* ---------------- one company ---------------- */

  function companyPage(id) {
    var c = Core.company(data, id);
    if (!c || !c.filer) return h('div', { cls: 'page' }, h('p', { cls: 'none', text: 'That company is not one of the nineteen.' }), h('p', null, h('a', { href: '#/', text: 'All companies' })));
    var ins = data.insights[id] || [];
    var by = function (topic) { return ins.filter(function (x) { return x.topic === topic; }); };
    var src = data.sources[c.annual.source];
    var page = h('div', { cls: 'page' },
      h('p', { cls: 'crumb' }, h('a', { href: '#/', text: 'Companies' })),
      h('section', { cls: 'hero small' },
        h('p', { cls: 'eyebrow', text: layerName(c.layer) }),
        h('h1', { text: c.name }),
        h('p', { cls: 'lede' }, c.legal + ' · reports in ' + (c.currency === 'USD' ? 'US dollars' : c.currency === 'EUR' ? 'euros' : 'New Taiwan dollars') + ' · latest annual report: ', ext(src.url, 'Form ' + src.form + ' for the year ended ' + src.period), ', filed ' + src.date + '.')));
    var grid = h('div', { cls: 'grid' });
    page.appendChild(grid);
    var defs = [
      { topic: 'revenue', title: 'Revenue', kind: 'bar', get: function (fy) { var f = Core.fig(data, id, 'revenue', fy); return f ? { v: f.v, cites: [id + '.revenue.' + fy] } : null; }, money: true },
      { topic: 'margin', title: 'Gross margin', kind: 'line', get: function (fy) { return Core.derived(data, id, 'grossMargin', fy); } },
      { topic: 'rd', title: 'R&D as a share of revenue', kind: 'line', get: function (fy) { return Core.derived(data, id, 'rdIntensity', fy); } },
      { topic: 'capex', title: 'Capital spending', kind: 'bar', get: function (fy) { var f = Core.fig(data, id, 'capex', fy); return f ? { v: f.v, cites: [id + '.capex.' + fy] } : null; }, money: true },
      { topic: 'inventory', title: 'Inventory days', kind: 'line', days: true, get: function (fy) { return Core.derived(data, id, 'inventoryDays', fy); } },
    ];
    var pending = [];
    defs.forEach(function (d) {
      var points = c.years.map(function (fy) { var x = d.get(fy); return { fy: fy, v: x ? x.v : null, cites: x ? x.cites : [] }; });
      var have = points.filter(function (p) { return p.v !== null; });
      var fmt = d.money ? function (v) { return Core.money(v, c.currency); } : d.days ? function (v) { return Math.round(v) + ' days'; } : function (v) { return Core.pct(v, 1); };
      var tick = d.money ? function (v) { return Core.money(v, c.currency, true); } : d.days ? function (v) { return String(Math.round(v)); } : function (v) { return Core.pct(v, 0); };
      var latest = have.length ? have[have.length - 1] : null;
      var host = h('div', { cls: 'chart-host' });
      var card = h('section', { cls: 'card pad' },
        h('h2', { cls: 'card-t', text: d.title }),
        latest ? h('p', { cls: 'big' }, h('span', { text: fmt(latest.v) }), h('span', { cls: 'big-s', text: ' FY' + latest.fy })) : h('p', { cls: 'none', text: 'Not tagged in this company’s filings.' }),
        by(d.topic).map(sentence), host,
        have.length ? tableOf(['Fiscal year', d.title, 'Source'], have.map(function (p) { return ['FY' + p.fy, fmt(p.v), srcButton('Filing', d.title + ', FY' + p.fy, p.cites)]; })) : null);
      grid.appendChild(card);
      if (have.length) pending.push(function () { seriesChart(host, { title: d.title, kind: d.kind, points: points, years: c.years, fmt: fmt, tick: tick }); });
    });
    var mixes = data.mixes[id] || [];
    var rev = Core.fig(data, id, 'revenue', c.latest);
    mixes.forEach(function (mix) {
      var j = mix.years.indexOf(c.latest);
      if (j < 0 || !rev) return;
      grid.appendChild(h('section', { cls: 'card pad' },
        h('h2', { cls: 'card-t', text: 'Revenue ' + mix.title.toLowerCase() + ', FY' + c.latest }),
        ins.filter(function (x) { return x.topic === 'mix' && x.cites[0].indexOf('.mix.' + mix.kind + '.') > 0; }).map(sentence),
        barList(mix.parts.filter(function (p) { return p.vals[j] !== null; }).map(function (p) {
          var i = mix.parts.indexOf(p);
          return { label: p.label, share: p.vals[j] / rev.v, value: Core.money(p.vals[j], c.currency, true) + ' · ' + Core.pct(p.vals[j] / rev.v, 0), cites: [id + '.mix.' + mix.kind + '.' + c.latest + '.' + i] };
        }))));
    });
    var conc = (data.concentration[id] || []).filter(function (k) { return k.fy === c.latest; });
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Customer concentration, FY' + c.latest }),
      conc.length ? [by('customers').map(sentence), barList(conc.map(function (k) { return { label: k.label, sub: k.within ? '(' + k.within + ')' : '', share: k.pct, value: Core.pct(k.pct, 0) + ' of revenue', cites: [k.id] }; })),
        h('p', { cls: 'note', text: 'Labels are the report’s own. Most reports do not name the customer.' })]
        : h('p', { cls: 'none', text: 'The latest annual report tags no single customer’s share of revenue.' })));
    var mine = data.edges.filter(function (e) { return e.from === id || e.to === id; });
    page.appendChild(h('section', { cls: 'group' },
      h('h2', { text: 'Named in the filings' }),
      h('p', { cls: 'group-sub', text: 'Relationships a primary document states, with ' + c.name + ' on one side. Tap one for the exact words.' }),
      mine.length ? edgeRows(mine) : h('p', { cls: 'none card pad', text: 'No document in this set names a relationship with ' + c.name + '.' }),
      h('p', { cls: 'more' }, h('a', { cls: 'pill', href: '#/map/' + id, text: 'Follow ' + c.name + ' on the map' }))));
    page._after = function () { pending.forEach(function (f) { f(); }); };
    return page;
  }

  function family(type) { return type === 'competitor' ? 'rival' : type === 'partner' || type === 'investor' ? 'tie' : 'supply'; }
  function pairTitle(e) { return nameOf(e.from) + (Core.DIRECTED[e.type] ? ' → ' : ' · ') + nameOf(e.to); }
  function verb(e) {
    return { supplier: 'supplies', customer: 'sells to', service: 'provides a service or platform to', investor: 'has invested in', partner: 'partners with', competitor: 'is named as a competitor by' }[e.type];
  }
  function edgeLine(e) { return e.type === 'competitor' ? nameOf(e.to) + ' is named as a competitor by ' + nameOf(e.from) : nameOf(e.from) + ' ' + verb(e) + ' ' + nameOf(e.to); }
  function openPair(a, b) {
    var es = data.edges.filter(function (e) { return (e.from === a && e.to === b) || (e.from === b && e.to === a); });
    openSheet(nameOf(a) + ' and ' + nameOf(b), [h('p', { cls: 'src-l', text: es.length + (es.length === 1 ? ' statement' : ' statements') + ' in primary documents.' })].concat(es.map(edgeCard)));
  }
  function edgeRows(edges) {
    return h('ul', { cls: 'rows card' }, edges.map(function (e) {
      return h('li', null, h('button', { type: 'button', cls: 'row', on: { click: function () { openPair(e.from, e.to); } } },
        h('span', { cls: 'tile t-' + family(e.type), 'aria-hidden': 'true', text: Core.DIRECTED[e.type] ? '→' : '↔' }),
        h('span', { cls: 'row-main' }, h('span', { cls: 'row-t', text: edgeLine(e) }), h('span', { cls: 'row-s', text: Core.TYPE_NAMES[e.type] + ' · said by ' + nameOf(e.by) + ' · ' + e.section })),
        h('span', { cls: 'chev', 'aria-hidden': 'true', text: '›' })));
    }));
  }

  /* ---------------- patterns ---------------- */

  function heat(p) {
    var years = p.chart.years;
    var rows = p.chart.rows.map(function (r) {
      var vals = r.cells.filter(Boolean).map(function (x) { return x.v; });
      var lo = Math.min.apply(null, vals); var hi = Math.max.apply(null, vals);
      return h('tr', null, h('th', { scope: 'row' }, h('a', { href: '#/c/' + r.c, text: nameOf(r.c) }), h('span', { cls: 'sub', text: ' ' + layerName(r.layer) })),
        r.cells.map(function (x) {
          if (!x) return h('td', { cls: 'hc none', text: '–' });
          var step = hi > lo ? Math.round(((x.v - lo) / (hi - lo)) * 5) : 0;
          return h('td', { cls: 'hc' }, h('button', { type: 'button', cls: 'hb h' + step, 'aria-label': nameOf(r.c) + ', FY' + x.fy + ': ' + Math.round(x.v) + ' days. Open the sources.', on: { click: function () { showCites(nameOf(r.c) + ' inventory days, FY' + x.fy, x.cites); } } }, String(Math.round(x.v))));
        }));
    });
    return h('div', { cls: 'scroll' }, h('table', { cls: 'heat' },
      h('caption', { cls: 'sr', text: 'Inventory days by company and fiscal year. Each row is shaded against that company’s own range.' }),
      h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Company' }), years.map(function (y) { return h('th', { scope: 'col', text: 'FY' + String(y).slice(2) }); }))),
      h('tbody', null, rows)),
      h('p', { cls: 'note', text: 'Days of cost of revenue held in inventory. Each row is shaded from that company’s own low (faint) to its own high (strong).' }));
  }
  function scatter(host, p) {
    var pts = p.chart.points;
    var W = Math.max(280, host.clientWidth); var H = Math.min(420, Math.max(300, W * 0.6));
    var L = 44; var R = 16; var T = 14; var B = 38;
    var mx = niceMax(Math.max.apply(null, pts.map(function (q) { return q.x; })));
    var X = function (v) { return L + (v / mx) * (W - L - R); };
    var Y = function (v) { return T + (1 - v) * (H - T - B); };
    var svg = s('svg', { cls: 'chart', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': p.title });
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
      svg.appendChild(s('line', { cls: 'grid', x1: L, x2: W - R, y1: r1(Y(v)), y2: r1(Y(v)) }));
      svg.appendChild(s('text', { cls: 'axis', x: L - 6, y: r1(Y(v)) + 4, 'text-anchor': 'end', text: Core.pct(v, 0) }));
    });
    [0, 0.5, 1].forEach(function (k) { svg.appendChild(s('text', { cls: 'axis', x: r1(X(mx * k)), y: H - 20, 'text-anchor': k === 0 ? 'start' : k === 1 ? 'end' : 'middle', text: Core.pct(mx * k, 0) })); });
    svg.appendChild(s('text', { cls: 'axis-t', x: r1((L + W - R) / 2), y: H - 4, 'text-anchor': 'middle', text: 'R&D as a share of revenue →' }));
    svg.appendChild(s('text', { cls: 'axis-t', x: L, y: 10, text: '↑ Gross margin' }));
    var placed = [];
    var sorted = pts.slice().sort(function (a, b) { return b.y - a.y; });
    var tp = tip(svg);
    sorted.forEach(function (q) {
      var x = X(q.x); var y = Y(q.y); var name = nameOf(q.c); var w = name.length * 6.1;
      var opts = [[x + 8, y + 4, 'start'], [x - 8, y + 4, 'end'], [x + 8, y - 8, 'start'], [x + 8, y + 15, 'start'], [x - 8, y - 8, 'end'], [x - 8, y + 15, 'end']];
      var pick = null;
      opts.some(function (o) {
        var x0 = o[2] === 'start' ? o[0] : o[0] - w;
        if (x0 < L || x0 + w > W - 2) return false;
        var box = [x0, o[1] - 10, x0 + w, o[1] + 2];
        var hit = placed.some(function (b) { return !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]); });
        if (!hit) { pick = o; placed.push(box); return true; }
        return false;
      });
      placed.push([x - 6, y - 6, x + 6, y + 6]);
      svg.appendChild(s('circle', { cls: 'dot big', cx: r1(x), cy: r1(y), r: 5 }));
      if (pick) svg.appendChild(s('text', { cls: 'lbl', x: r1(pick[0]), y: r1(pick[1]), 'text-anchor': pick[2], text: name }));
      var label = name + ', FY' + q.fy + ': R&D ' + Core.pct(q.x, 1) + ' of revenue, gross margin ' + Core.pct(q.y, 1);
      var hit = s('circle', { cls: 'hit', cx: r1(x), cy: r1(y), r: 14, tabindex: 0, role: 'button', 'aria-label': label + '. Open the sources.' });
      var on = function () { tp.show(x, y - 6, name + ' · FY' + q.fy, 'R&D ' + Core.pct(q.x, 1) + ' · margin ' + Core.pct(q.y, 1), W); };
      hit.addEventListener('pointerenter', on); hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', tp.hide); hit.addEventListener('blur', tp.hide);
      var go = function () { showCites(name + ', FY' + q.fy, q.cites); };
      hit.addEventListener('click', go);
      hit.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      svg.appendChild(hit);
    });
    svg.appendChild(svg.querySelector('.tip'));
    host.appendChild(svg);
  }
  function lines(host, p) {
    var ser = p.chart.series;
    var W = Math.max(280, host.clientWidth); var H = 260; var L = 48; var R = 14; var T = 12; var B = 24;
    var years = [];
    ser.forEach(function (x) { x.points.forEach(function (q) { if (years.indexOf(q.fy) < 0) years.push(q.fy); }); });
    years.sort();
    var max = niceMax(Math.max.apply(null, ser.map(function (x) { return Math.max.apply(null, x.points.map(function (q) { return q.v; })); })));
    var band = (W - L - R) / years.length;
    var X = function (fy) { return L + band * (years.indexOf(fy) + 0.5); };
    var Y = function (v) { return T + (1 - v / max) * (H - T - B); };
    var svg = s('svg', { cls: 'chart', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': p.title });
    [0, 0.5, 1].forEach(function (k) {
      svg.appendChild(s('line', { cls: 'grid', x1: L, x2: W - R, y1: r1(Y(max * k)), y2: r1(Y(max * k)) }));
      svg.appendChild(s('text', { cls: 'axis', x: L - 6, y: r1(Y(max * k)) + 4, 'text-anchor': 'end', text: Core.money(max * k, 'USD', true) }));
    });
    var step = Math.ceil(years.length / Math.floor((W - L - R) / 34));
    years.forEach(function (fy, i) { if ((years.length - 1 - i) % step === 0) svg.appendChild(s('text', { cls: 'axis', x: r1(X(fy)), y: H - 6, 'text-anchor': 'middle', text: '’' + String(fy).slice(2) })); });
    ser.forEach(function (x, i) {
      svg.appendChild(s('path', { cls: 'line c' + (i + 1), d: x.points.map(function (q, j) { return (j ? 'L' : 'M') + r1(X(q.fy)) + ' ' + r1(Y(q.v)); }).join('') }));
      x.points.forEach(function (q) { svg.appendChild(s('circle', { cls: 'dot c' + (i + 1), cx: r1(X(q.fy)), cy: r1(Y(q.v)), r: 3.5 })); });
    });
    var cross = s('line', { cls: 'cross', y1: T, y2: H - B });
    svg.appendChild(cross);
    var tp = tip(svg);
    years.forEach(function (fy) {
      var here = ser.map(function (x) { return x.points.filter(function (q) { return q.fy === fy; })[0] || null; });
      var txt = here.map(function (q, i) { return q ? ['Cloud', 'Chips', 'Equip.'][i] + ' ' + Core.money(q.v, 'USD', true) : null; }).filter(Boolean).join(' · ');
      var cites = [].concat.apply([], here.filter(Boolean).map(function (q) { return q.cites; }));
      var hit = s('rect', { cls: 'hit', x: r1(X(fy) - band / 2), y: T, width: r1(band), height: H - T, tabindex: 0, role: 'button', 'aria-label': 'FY' + fy + ': ' + txt + '. Open the sources.' });
      var on = function () { cross.setAttribute('x1', r1(X(fy))); cross.setAttribute('x2', r1(X(fy))); cross.classList.add('on'); tp.show(X(fy), T + 50, 'FY' + fy, txt, W); };
      var off = function () { cross.classList.remove('on'); tp.hide(); };
      hit.addEventListener('pointerenter', on); hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', off); hit.addEventListener('blur', off);
      var go = function () { showCites(p.title + ', FY' + fy, cites); };
      hit.addEventListener('click', go);
      hit.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      svg.insertBefore(hit, cross);
    });
    host.appendChild(h('ul', { cls: 'legend' }, ser.map(function (x, i) { return h('li', null, s('svg', { width: 18, height: 10, 'aria-hidden': 'true' }, s('line', { cls: 'line c' + (i + 1), x1: 1, x2: 17, y1: 5, y2: 5 })), x.name + ' (' + x.who.map(nameOf).join(', ') + ')'); })));
    host.appendChild(svg);
  }
  function patternsPage() {
    var page = h('div', { cls: 'page' },
      h('section', { cls: 'hero small' }, h('p', { cls: 'eyebrow', text: 'Across companies' }), h('h1', { text: 'Patterns' }),
        h('p', { cls: 'lede', text: 'The same reported figures, set side by side. Each sentence cites the figures it rests on; tap a point, a cell or a bar for its filing.' })));
    var pending = [];
    data.patterns.forEach(function (p) {
      var host = h('div', { cls: 'chart-host' });
      var body;
      if (p.chart.type === 'heat') body = heat(p);
      else if (p.chart.type === 'bars') {
        body = barList(p.chart.rows.map(function (r) { return { label: nameOf(r.c), sub: '“' + r.label + '”, FY' + r.fy + (r.named ? ' · named in its XBRL data' : ''), share: r.v, value: Core.pct(r.v, 0), cites: [r.cite] }; }));
      } else {
        body = host;
        pending.push(function () { (p.chart.type === 'scatter' ? scatter : lines)(host, p); });
      }
      var table = null;
      if (p.chart.type === 'scatter') table = tableOf(['Company', 'Fiscal year', 'R&D ÷ revenue', 'Gross margin', 'Sources'], p.chart.points.map(function (q) { return [nameOf(q.c), 'FY' + q.fy, Core.pct(q.x, 1), Core.pct(q.y, 1), srcButton('Filings', nameOf(q.c), q.cites)]; }));
      if (p.chart.type === 'lines') {
        table = tableOf(['Group', 'Fiscal year', 'Total', 'Sources'], [].concat.apply([], p.chart.series.map(function (x) { return x.points.map(function (q) { return [x.name, 'FY' + q.fy, Core.money(q.v, 'USD'), srcButton('Filings', x.name + ', FY' + q.fy, q.cites)]; }); })));
      }
      page.appendChild(h('section', { cls: 'card pad pattern', id: 'p-' + p.id },
        h('h2', { cls: 'card-t', text: p.title }), h('p', { cls: 'p-lede', text: p.lede }), body, table,
        h('div', { cls: 'says' }, p.sentences.map(sentence)),
        h('p', { cls: 'note', text: 'How it is worked out: ' + p.method })));
    });
    page._after = function () { pending.forEach(function (f) { f(); }); };
    return page;
  }

  /* ---------------- the map ---------------- */

  function groups() {
    // One line per pair and family; the statements behind it are in the sheet.
    var out = {}; var list = [];
    data.edges.forEach(function (e) {
      if (!mapState.types[e.type]) return;
      var a = Core.company(data, e.from); var b = Core.company(data, e.to);
      if (!mapState.layers[a.layer] || !mapState.layers[b.layer]) return;
      var fam = family(e.type);
      var key = (fam === 'supply' || e.type === 'investor' ? e.from + '>' + e.to : [e.from, e.to].sort().join('~')) + '|' + fam;
      if (!out[key]) { out[key] = { key: key, from: e.from, to: e.to, fam: fam, directed: fam === 'supply' || e.type === 'investor', edges: [] }; list.push(out[key]); } else if (e.type === 'investor') out[key].directed = true;
      out[key].edges.push(e);
    });
    return list;
  }
  function flow(focus) {
    var up = {}; var down = {};
    var walk = function (start, set, dir) {
      var q = [start];
      while (q.length) {
        var cur = q.shift();
        data.edges.forEach(function (e) {
          if (family(e.type) !== 'supply' || !mapState.types[e.type]) return;
          var next = dir === 'up' ? (e.to === cur ? e.from : null) : (e.from === cur ? e.to : null);
          if (next && !set[next] && next !== start) { set[next] = true; q.push(next); }
        });
      }
    };
    walk(focus, up, 'up'); walk(focus, down, 'down');
    return { up: up, down: down };
  }
  function nodeSize(c, max) {
    if (!c.filer) return 6;
    var f = Core.fig(data, c.id, c.currency === 'TWD' ? 'revenueUsd' : 'revenue', c.latest);
    return 9 + 19 * Math.sqrt((f ? f.v : 0) / max);
  }
  function drawMap(host) {
    clear(host);
    var W = Math.max(300, host.clientWidth);
    var cols = W >= 760;
    var max = Math.max.apply(null, data.companies.map(function (c) { var f = Core.fig(data, c.id, c.currency === 'TWD' ? 'revenueUsd' : 'revenue', c.latest); return f ? f.v : 0; }));
    var layers = data.layers.filter(function (l) { return mapState.layers[l.id]; });
    var pos = {}; var H = 0; var heads = [];
    var all = data.companies.concat(data.others);
    var gs = groups();
    var used = {};
    gs.forEach(function (g) { used[g.from] = true; used[g.to] = true; });
    if (cols) {
      var cw = W / layers.length;
      layers.forEach(function (l, i) {
        var fs = all.filter(function (c) { return c.layer === l.id && c.filer; });
        var os = all.filter(function (c) { return c.layer === l.id && !c.filer && used[c.id]; });
        heads.push({ x: cw * i + cw / 2, y: 22, text: l.name });
        fs.forEach(function (c, j) { pos[c.id] = { x: cw * i + cw * 0.3, y: 78 + j * 78, c: c, r: nodeSize(c, max), lab: 'below' }; });
        os.forEach(function (c, j) { pos[c.id] = { x: cw * i + cw * 0.68, y: 62 + j * 34, c: c, r: 6, lab: 'right' }; });
        H = Math.max(H, 78 + fs.length * 78, 62 + os.length * 34 + 10);
      });
    } else {
      var y = 0; var per = 3; var cellW = W / per;
      layers.forEach(function (l) {
        var fs = all.filter(function (c) { return c.layer === l.id && c.filer; });
        var os = all.filter(function (c) { return c.layer === l.id && !c.filer && used[c.id]; });
        heads.push({ x: 12, y: y + 22, text: l.name, left: true });
        y += 38;
        fs.forEach(function (c, j) { pos[c.id] = { x: cellW * (j % per) + cellW / 2, y: y + Math.floor(j / per) * 84 + 30, c: c, r: nodeSize(c, max) * 0.85, lab: 'below' }; });
        y += Math.ceil(fs.length / per) * 84;
        os.forEach(function (c, j) { pos[c.id] = { x: cellW * (j % per) + 14, y: y + Math.floor(j / per) * 32 + 16, c: c, r: 5, lab: 'right' }; });
        y += Math.ceil(os.length / per) * 32 + 22;
      });
      H = y;
    }
    var svg = s('svg', { cls: 'map', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': 'Map of stated relationships. Lines and companies are buttons; the same content is in the list view.' });
    var defs = s('defs');
    ['supply', 'tie'].forEach(function (f) { defs.appendChild(s('marker', { id: 'arr-' + f, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, s('path', { cls: 'arr m-' + f, d: 'M0 0L10 5L0 10z' }))); });
    svg.appendChild(defs);
    if (cols) layers.forEach(function (l, i) { if (i) svg.appendChild(s('line', { cls: 'grid', x1: r1((W / layers.length) * i), x2: r1((W / layers.length) * i), y1: 8, y2: H - 8 })); });
    heads.forEach(function (hd) { svg.appendChild(s('text', { cls: 'm-head', x: hd.x, y: hd.y, 'text-anchor': hd.left ? 'start' : 'middle', text: hd.text })); });
    var fl = mapState.focus && pos[mapState.focus] ? flow(mapState.focus) : null;
    var inFlow = function (id) { return fl && (id === mapState.focus || fl.up[id] || fl.down[id]); };
    var gEdges = s('g'); var gHits = s('g'); var gNodes = s('g');
    gs.forEach(function (g) {
      var a = pos[g.from]; var b = pos[g.to];
      if (!a || !b) return;
      var dx = b.x - a.x; var dy = b.y - a.y; var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var x1 = a.x + (dx / dist) * (a.r + 2); var y1 = a.y + (dy / dist) * (a.r + 2);
      var x2 = b.x - (dx / dist) * (b.r + 5); var y2 = b.y - (dy / dist) * (b.r + 5);
      var d;
      var bend = g.fam === 'rival' ? 0.18 : g.fam === 'tie' ? -0.14 : 0.06;
      var mxp = (x1 + x2) / 2 - (y2 - y1) * bend; var myp = (y1 + y2) / 2 + (x2 - x1) * bend;
      d = 'M' + r1(x1) + ' ' + r1(y1) + 'Q' + r1(mxp) + ' ' + r1(myp) + ' ' + r1(x2) + ' ' + r1(y2);
      var lit = !fl ? true : (g.from === mapState.focus || g.to === mapState.focus) || (g.fam === 'supply' && ((fl.up[g.from] || g.from === mapState.focus) && (fl.up[g.to] || g.to === mapState.focus) || (fl.down[g.from] || g.from === mapState.focus) && (fl.down[g.to] || g.to === mapState.focus)));
      gEdges.appendChild(s('path', { cls: 'edge e-' + g.fam + (lit ? '' : ' dim') + (fl && lit ? ' lit' : ''), d: d, 'marker-end': g.directed ? 'url(#arr-' + (g.fam === 'tie' ? 'tie' : 'supply') + ')' : null }));
      var label = g.edges.map(edgeLine).filter(function (x, i, arr) { return arr.indexOf(x) === i; }).join('; ') + '. ' + g.edges.length + (g.edges.length === 1 ? ' statement' : ' statements') + '. Open the quote.';
      var hit = s('path', { cls: 'ehit', d: d, tabindex: lit ? 0 : -1, role: 'button', 'aria-label': label });
      var go = function () { openPair(g.from, g.to); };
      hit.addEventListener('click', go);
      hit.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      if (lit) gHits.appendChild(hit);
    });
    Object.keys(pos).forEach(function (id) {
      var p = pos[id]; var c = p.c;
      var dim = fl && !inFlow(id) && !gs.some(function (g) { return (g.from === id && g.to === mapState.focus) || (g.to === id && g.from === mapState.focus); });
      var g = s('g', { cls: 'node' + (c.filer ? '' : ' other') + (dim ? ' dim' : '') + (id === mapState.focus ? ' focus' : ''), tabindex: 0, role: 'button', 'aria-pressed': id === mapState.focus ? 'true' : 'false', 'aria-label': c.name + (c.filer ? '' : ' (not one of the nineteen; named by others)') + '. Follow the flow from here.' },
        s('circle', { cx: r1(p.x), cy: r1(p.y), r: r1(p.r) }),
        p.lab === 'below' ? s('text', { x: r1(p.x), y: r1(p.y + p.r + 14), 'text-anchor': 'middle', text: c.name }) : s('text', { cls: 'small', x: r1(p.x + p.r + 5), y: r1(p.y + 4), text: cols || c.name.length <= 15 ? c.name : c.name.slice(0, 14) + '…' }),
        s('rect', { cls: 'nhit', x: r1(p.x - Math.max(22, p.r)), y: r1(p.y - Math.max(22, p.r)), width: r1(Math.max(44, p.r * 2)), height: r1(Math.max(44, p.r * 2)) }));
      var go = function () { mapState.focus = mapState.focus === id ? null : id; renderMapPart(); };
      g.addEventListener('click', go);
      g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      gNodes.appendChild(g);
    });
    svg.appendChild(gEdges); svg.appendChild(gNodes); svg.appendChild(gHits);
    host.appendChild(svg);
  }
  var renderMapPart = function () {};
  function mapPage(focus) {
    if (focus && Core.company(data, focus)) mapState.focus = focus;
    var host = h('div', { cls: 'map-host' });
    var listHost = h('div', { cls: 'list-host' });
    var info = h('div', { cls: 'flow-info', 'aria-live': 'polite' });
    var chip = function (label, on, fn, extra) { return h('button', { type: 'button', cls: 'chip' + (extra ? ' ' + extra : ''), 'aria-pressed': on ? 'true' : 'false', on: { click: fn } }, label); };
    var typeBar = h('div', { cls: 'chips', role: 'group', 'aria-label': 'Relationship types' });
    var layerBar = h('div', { cls: 'chips', role: 'group', 'aria-label': 'Layers' });
    var viewBar = h('div', { cls: 'seg', role: 'group', 'aria-label': 'View' });
    var select = h('select', { id: 'flow', cls: 'input', on: { change: function () { mapState.focus = select.value || null; renderMapPart(); } } });
    var bars = function () {
      clear(typeBar); clear(layerBar); clear(viewBar);
      Object.keys(Core.TYPE_NAMES).forEach(function (t) { typeBar.appendChild(chip(Core.TYPE_NAMES[t], mapState.types[t], function () { mapState.types[t] = !mapState.types[t]; renderMapPart(); }, 'k-' + family(t))); });
      data.layers.forEach(function (l) { layerBar.appendChild(chip(l.name, mapState.layers[l.id], function () { mapState.layers[l.id] = !mapState.layers[l.id]; renderMapPart(); })); });
      ['map', 'list'].forEach(function (v) { viewBar.appendChild(chip(v === 'map' ? 'Map' : 'List', mapState.view === v, function () { mapState.view = v; renderMapPart(); })); });
      clear(select);
      select.appendChild(h('option', { value: '', text: 'No company (show everything)' }));
      data.companies.concat(data.others).forEach(function (c) { select.appendChild(h('option', { value: c.id, selected: c.id === mapState.focus, text: c.name })); });
      select.value = mapState.focus || '';
    };
    renderMapPart = function () {
      bars();
      var gs = groups();
      host.hidden = mapState.view !== 'map'; listHost.hidden = mapState.view !== 'list';
      if (mapState.view === 'map') drawMap(host);
      else {
        clear(listHost);
        var shown = mapState.focus ? gs.filter(function (g) { return g.from === mapState.focus || g.to === mapState.focus; }) : gs;
        listHost.appendChild(h('div', { cls: 'scroll card' }, h('table', { cls: 'etable' },
          h('caption', { cls: 'sr', text: 'Stated relationships' }),
          h('thead', null, h('tr', null, ['From', 'Relationship', 'To', 'Said by', 'Quote'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, [].concat.apply([], shown.map(function (g) { return g.edges; })).map(function (e) {
            return h('tr', null, h('th', { scope: 'row', text: nameOf(e.from) }), h('td', { text: Core.TYPE_NAMES[e.type] }), h('td', { text: nameOf(e.to) }), h('td', { text: nameOf(e.by) }),
              h('td', null, h('button', { type: 'button', cls: 'cite', on: { click: function () { openSheet(pairTitle(e), [edgeCard(e)]); } } }, 'Read it')));
          })))));
      }
      clear(info);
      if (mapState.focus) {
        var fl = flow(mapState.focus);
        var names = function (set) { var k = Object.keys(set); return k.length ? k.map(nameOf).join(', ') : 'none stated'; };
        var direct = data.edges.filter(function (e) { return (e.from === mapState.focus || e.to === mapState.focus) && mapState.types[e.type]; });
        var co = Core.company(data, mapState.focus);
        info.appendChild(h('div', { cls: 'card pad' },
          h('h2', { cls: 'card-t', text: 'Following ' + co.name }),
          h('p', { cls: 'say' }, h('strong', { text: 'Upstream ' }), '(named as supplying it, and who is named as supplying them): ' + names(fl.up) + '.'),
          h('p', { cls: 'say' }, h('strong', { text: 'Downstream ' }), '(named as supplied by it, and onward): ' + names(fl.down) + '.'),
          h('p', { cls: 'note', text: 'A chain is only as long as the documents say: each link is one company’s statement, and two links in a row do not mean the first company’s product ends up in the last one’s.' }),
          h('p', { cls: 'more' }, co.filer ? h('a', { cls: 'pill', href: '#/c/' + co.id, text: co.name + '’s figures' }) : null, ' ', h('button', { type: 'button', cls: 'pill ghost', on: { click: function () { mapState.focus = null; renderMapPart(); } } }, 'Clear'))));
        if (direct.length) info.appendChild(edgeRows(direct));
      }
    };
    var page = h('div', { cls: 'page wide' },
      h('section', { cls: 'hero small' }, h('p', { cls: 'eyebrow', text: 'Stated relationships' }), h('h1', { text: 'The map' }),
        h('p', { cls: 'lede', text: 'Supply runs left to right on a wide screen and top to bottom on a phone: equipment, chips, devices, cloud. A line is drawn only where a company’s own document names the other. Tap a line for the quote; tap a company to follow the flow.' })),
      h('section', { cls: 'card pad controls' },
        h('div', { cls: 'ctl' }, h('span', { cls: 'ctl-l', text: 'Show' }), typeBar),
        h('div', { cls: 'ctl' }, h('span', { cls: 'ctl-l', text: 'Layers' }), layerBar),
        h('div', { cls: 'ctl' }, h('label', { cls: 'ctl-l', for: 'flow', text: 'Follow the flow from' }), select, viewBar)),
      h('section', { cls: 'card map-card' }, host, listHost,
        h('ul', { cls: 'legend pad' },
          h('li', null, s('svg', { width: 26, height: 10, 'aria-hidden': 'true' }, s('line', { cls: 'edge e-supply', x1: 1, x2: 25, y1: 5, y2: 5 })), 'Supply, sales or service (arrow shows direction)'),
          h('li', null, s('svg', { width: 26, height: 10, 'aria-hidden': 'true' }, s('line', { cls: 'edge e-tie', x1: 1, x2: 25, y1: 5, y2: 5 })), 'Partner or investor'),
          h('li', null, s('svg', { width: 26, height: 10, 'aria-hidden': 'true' }, s('line', { cls: 'edge e-rival', x1: 1, x2: 25, y1: 5, y2: 5 })), 'Competitor, as stated'),
          h('li', null, s('svg', { width: 14, height: 14, 'aria-hidden': 'true', cls: 'node' }, s('circle', { cx: 7, cy: 7, r: 6 })), 'One of the nineteen, sized by latest revenue'),
          h('li', null, s('svg', { width: 14, height: 14, 'aria-hidden': 'true', cls: 'node other' }, s('circle', { cx: 7, cy: 7, r: 5 })), 'Another company, shown only because a document names it')),
        h('p', { cls: 'note pad', text: 'Circle sizes use US-dollar revenue; TSMC’s is its own dollar translation and ASML’s is its euro figure, unconverted. A missing line means no document in this set states the link - not that there is none.' })),
      info);
    page._after = renderMapPart;
    return page;
  }

  /* ---------------- routing ---------------- */

  function route() {
    if (!data) return;
    if (sheet.open) sheet.close();
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var page; var tab = 'home';
    if (parts[0] === 'c' && parts[1]) page = companyPage(parts[1].toUpperCase());
    else if (parts[0] === 'patterns') { page = patternsPage(); tab = 'patterns'; } else if (parts[0] === 'map') { page = mapPage(parts[1] ? parts[1].toUpperCase() : null); tab = 'map'; } else page = home();
    clear(main); main.appendChild(page);
    if (page._after) page._after();
    Array.prototype.forEach.call(document.querySelectorAll('.tabs a'), function (a) { if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    lastWidth = main.clientWidth;
    if (parts[0] === 'patterns' && parts[1]) { var t = document.getElementById('p-' + parts[1]); if (t) t.scrollIntoView(); } else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  var timer = null;
  window.addEventListener('resize', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { if (data && main.clientWidth !== lastWidth && !sheet.open) route(); }, 200);
  });

  fetch(BASE + 'data/dataset.json').then(function (r) { if (!r.ok) throw new Error('no data'); return r.json(); }).then(function (d) {
    data = d;
    document.getElementById('built').textContent = 'Dataset built ' + d.built + ' from ' + Object.keys(d.sources).length + ' primary documents and ' + Object.keys(d.filings).length + ' filings.';
    route();
  }).catch(function () {
    clear(main);
    main.appendChild(h('p', { cls: 'none', text: 'The dataset could not be loaded. Reload to try again.' }));
  });
}());
