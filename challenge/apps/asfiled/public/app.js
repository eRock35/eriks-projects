// As Filed - the page. It draws what is in data/ and, for a company looked
// up on request, what this app's own server answers (api/lookup). It makes
// no request to any other origin: links open the sources, and sec.gov is
// only ever reached by the server. The data comes in parts (see
// AsFiledCore.split): data/index.json first, then data/patterns.json or
// data/c/<ID>.json when a view needs it.
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
  // Competitors and auditors start off: the first are the clutter, the second
  // a line from an audit firm to every company, which would crowd out the rest.
  var mapState = { types: { supplier: true, customer: true, service: true, auditor: false, partner: true, competitor: false }, layers: {}, focus: null, view: 'map', scope: 'linked' };
  // Companies shown by default on the map: the most stated links (fewer on a phone).
  var top = function () { return window.innerWidth < 760 ? 16 : 24; };
  var loaded = {};       // data part -> its promise
  var ready = {};        // data part -> true once merged in

  /** Load one part of the dataset (once) and merge it in. */
  function load(part) {
    if (!loaded[part]) {
      loaded[part] = fetch(BASE + Core.partPath(part)).then(function (r) { if (!r.ok) throw new Error('no data'); return r.json(); })
        .then(function (p) { if (part !== 'index') Core.merge(data, p); ready[part] = true; return p; });
      loaded[part].catch(function () { delete loaded[part]; });
    }
    return loaded[part];
  }

  /** One request to this app's own server (BASE-relative, same origin). */
  function request(path, opts) { return fetch(BASE + path, opts); }
  function api(method, path, body) {
    return request(path, { method: method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'That did not work.'); e.status = r.status; e.body = j; throw e; } return j; }); });
  }

  /* ---------------- companies looked up on request ----------------
   * Not part of the reviewed set: kept in data.lookups (never in
   * data.companies, so no count, list, pattern or sum includes them) and in
   * a layer of their own on the map. */

  var LABEL = 'Looked up on request - not in the reviewed set';
  var lookups = {};      // cik -> promise of its merged part
  var meta = {};         // company id -> { cik, at, stale, relations }
  var me = null;         // the signed-in account, once asked
  function lookupLayer() {
    if (!data.layers.some(function (l) { return l.id === 'lookup'; })) data.layers.push({ id: 'lookup', name: 'Looked up', blurb: LABEL });
    if (Object.keys(mapState.layers).length) mapState.layers.lookup = mapState.layers.lookup !== false;
  }
  function putLookup(c) {
    for (var i = 0; i < data.lookups.length; i += 1) if (data.lookups[i].id === c.id) { if (c.filer || !data.lookups[i].filer) data.lookups[i] = c; return; }
    data.lookups.push(c);
  }
  function mergeRelations(id, rel) {
    meta[id].relations = rel;
    if (!rel) return;
    data.sources[rel.source.id] = rel.source;
    rel.nodes.forEach(function (n) {
      if (n.lookup) { if (!Core.company(data, n.id)) putLookup(n); } else if (!Core.company(data, n.id)) data.others.push(n);
    });
    data.edges = data.edges.filter(function (e) { return !(e.lookup && e.by === id); }).concat(rel.edges.filter(function (e) { return Core.company(data, e.from) && Core.company(data, e.to); }));
  }
  function mergeLookup(part) {
    lookupLayer();
    putLookup(part.company);
    Core.merge(data, part);
    Object.keys(part.sources).forEach(function (k) { data.sources[k] = part.sources[k]; });
    meta[part.id] = { cik: part.cik, at: part.at, stale: part.stale, relations: null };
    mergeRelations(part.id, part.relations);
    remember(part);
    return part;
  }
  function loadLookup(cik) {
    if (!lookups[cik]) {
      lookups[cik] = api('GET', 'api/lookup/' + cik).then(function (p) { return p.inSet ? p : mergeLookup(p); });
      lookups[cik].catch(function () { delete lookups[cik]; });
    }
    return lookups[cik];
  }
  // The last few companies this browser looked up, for the home page. Kept
  // here only; never sent anywhere.
  function recent() { try { var v = JSON.parse(localStorage.getItem('asfiled-lookups') || '[]'); return Array.isArray(v) ? v.filter(function (x) { return x && /^\d{1,10}$/.test(String(x.cik)) && typeof x.name === 'string'; }).slice(0, 8) : []; } catch (e) { return []; } }
  function remember(part) {
    try {
      var list = recent().filter(function (x) { return x.cik !== part.cik; });
      list.unshift({ cik: part.cik, name: String(part.company.name).slice(0, 80), ticker: String(part.ticker || '').slice(0, 12) });
      localStorage.setItem('asfiled-lookups', JSON.stringify(list.slice(0, 8)));
    } catch (e) { /* private mode: the list is simply not kept */ }
  }
  function loadMe() { return api('GET', 'api/auth/me').then(function (m) { me = m; return m; }, function () { me = { signedIn: false }; return me; }); }

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
  function safeUrl(u) { return /^https:\/\/www\.sec\.gov\//.test(String(u)) ? u : null; }
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
  function figLabel(f) { return Core.METRICS[f.m] || Core.METRICS[String(f.m).replace(/^d\./, '')] || (f.m === 'revenueUsd' ? 'Revenue (company’s own US-dollar translation)' : f.m === 'capexUsd' ? 'Capital spending (company’s own US-dollar translation)' : f.tag.charAt(0).toUpperCase() + f.tag.slice(1)); }
  function periodName(f) { var n = Core.daysBetween(f.start, f.end); return n <= 100 ? 'three months' : n < 200 ? 'six months' : n < 290 ? 'nine months' : 'fiscal year'; }
  function figureCard(fid) {
    var f = data.figures[fid];
    var src = Core.figureSource(data, fid);
    return h('div', { cls: 'src' },
      h('p', { cls: 'src-v' }, h('strong', { text: valueText(f) }), ' · ' + src.company + ' · ' + (f.start && /^d\./.test(f.m) ? periodName(f) + ' to ' + f.end : 'FY' + f.fy)),
      h('p', { cls: 'src-l', text: figLabel(f) + (Core.METRICS[f.m] || /Usd$/.test(f.m) || /^(d|pay)\./.test(f.m) ? ' (XBRL tag ' + f.tag + ')' : '') }),
      h('dl', { cls: 'kv' },
        h('dt', { text: 'Filing' }), h('dd', { text: 'Form ' + src.form + ', filed ' + src.filed }),
        h('dt', { text: 'Period' }), h('dd', { text: f.start && /^d\./.test(f.m) ? f.start + ' to ' + f.end + ' (' + periodName(f) + ')' : 'Fiscal year ended ' + f.end }),
        h('dt', { text: 'Accession no.' }), h('dd', { text: src.accn }),
        src.prior ? [h('dt', { text: 'Registrant' }), h('dd', { text: src.prior.legal + ' (CIK ' + src.prior.cik + '), the company’s earlier SEC registrant' })] : null),
      h('p', null, ext(src.url, 'Open this filing on sec.gov')));
  }
  function edgeCard(e) {
    var src = data.sources[e.source];
    var fig = e.fig ? data.figures[e.fig] : null;
    return h('div', { cls: 'src' },
      h('p', { cls: 'badge t-' + family(e.type), text: Core.TYPE_NAMES[e.type] }),
      e.lookup ? h('p', { cls: 'flag', text: LABEL }) : null,
      h('p', { cls: 'src-l', text: e.gloss }),
      h('blockquote', null, e.lead ? h('span', { cls: 'lead', text: e.lead + ' … ' }) : null, '“' + e.quote + '”'),
      fig ? h('p', { cls: 'src-l', text: 'Tagged beside that label: ' + Core.pct(fig.v, 0) + ' of revenue, FY' + fig.fy + '.' }) : null,
      h('dl', { cls: 'kv' },
        h('dt', { text: 'Who said it' }), h('dd', { text: nameOf(e.by) }),
        h('dt', { text: 'Document' }), h('dd', { text: src.title }),
        h('dt', { text: 'Section' }), h('dd', { text: e.section }),
        h('dt', { text: 'Filed' }), h('dd', { text: e.date })),
      h('p', null, ext(src.kind === 'xbrl' ? e.url : Core.quoteUrl(e), 'Open the source on sec.gov')));
  }
  var QUOTE_KIND = { employees: 'Employees, as stated', risk: 'Risk factor, this year', 'risk-was': 'Risk factor, the year before' };
  /** A quoted sentence that is not a relationship: the words, where they are, the link. */
  function quoteCard(qid) {
    var q = data.quotes[qid];
    var src = data.sources[q.source];
    var co = Core.company(data, q.c);
    return h('div', { cls: 'src' },
      h('p', { cls: 'badge t-tie', text: QUOTE_KIND[q.kind] || 'Quote' }),
      co && co.lookup ? h('p', { cls: 'flag', text: LABEL }) : null,
      h('blockquote', null, '“' + q.quote + '”'),
      q.kind === 'employees' ? h('p', { cls: 'src-l', text: 'The number read from that sentence: ' + Core.commas(q.n) + '.' }) : null,
      h('dl', { cls: 'kv' },
        h('dt', { text: 'Who said it' }), h('dd', { text: co ? co.name : q.c }),
        h('dt', { text: 'Document' }), h('dd', { text: src.title }),
        h('dt', { text: 'Section' }), h('dd', { text: q.section }),
        h('dt', { text: 'Filed' }), h('dd', { text: src.date })),
      h('p', null, ext(Core.quoteUrl({ url: src.url, quote: q.quote }), 'Open the source on sec.gov')));
  }
  function showCites(title, cites) {
    openSheet(title, cites.map(function (id) {
      if (data.figures[id]) return figureCard(id);
      if (data.quotes && data.quotes[id]) return quoteCard(id);
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
    var hi = Math.max.apply(null, pts.map(function (p) { return p.v; }));
    var lo = Math.min.apply(null, pts.map(function (p) { return p.v; }));
    var max = hi > 0 ? niceMax(hi) : 0;
    var min = lo < 0 ? -niceMax(-lo) : 0;
    if (max === min) max = min + 1;
    var xl = o.xlabel || function (fy) { return '’' + String(fy).slice(2); };
    var pl = o.plabel || function (fy) { return 'FY' + fy; };
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
    var step = Math.ceil(years.length / Math.floor(pw / (o.xwidth || 34)));
    years.forEach(function (fy, i) {
      if ((years.length - 1 - i) % step === 0) svg.appendChild(s('text', { cls: 'axis', x: r1(X(fy)), y: H - 6, 'text-anchor': 'middle', text: xl(fy) }));
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
        'aria-label': pl(p.fy) + ': ' + o.fmt(p.v) + '. Open the source.',
      });
      var on = function () { tp.show(X(p.fy), Y(Math.max(p.v, 0)), pl(p.fy), o.fmt(p.v), W); };
      hit.addEventListener('pointerenter', on); hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', tp.hide); hit.addEventListener('blur', tp.hide);
      var go = function () { showCites(o.title + ', ' + pl(p.fy), p.cites); };
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
    var vals = (c.spark || []).filter(function (v) { return v !== null; });
    if (vals.length < 3) return null;
    var max = Math.max.apply(null, vals);
    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + r1(2 + (i / (vals.length - 1)) * 60) + ' ' + r1(22 - (v / max) * 20); }).join('');
    return s('svg', { cls: 'spark', width: 64, height: 24, viewBox: '0 0 64 24', 'aria-hidden': 'true' }, s('path', { d: d }));
  }
  function home() {
    var nFig = data.counts.figures;
    var groupsEl = [];
    var find = h('input', { type: 'search', id: 'find', cls: 'input wide-input', placeholder: 'Name or ticker', autocomplete: 'off', spellcheck: 'false' });
    var none = h('p', { cls: 'none card pad', hidden: true, text: 'None of the ' + data.companies.length + ' reviewed companies matches that.' });
    // Past the reviewed set: any SEC registrant, by name or ticker.
    var lookBtn = h('button', { type: 'button', cls: 'pill', hidden: true });
    var lookOut = h('div', { cls: 'look-out', 'aria-live': 'polite' });
    var asked = 0;
    var doLookup = function () {
      var q = find.value.trim();
      if (!q) return;
      var mine = asked += 1;
      clear(lookOut); lookOut.appendChild(h('p', { cls: 'note', text: 'Searching the SEC’s list of registrants…' }));
      api('GET', 'api/lookup?q=' + encodeURIComponent(q)).then(function (r) {
        if (mine !== asked) return;
        clear(lookOut);
        if (!r.matches.length) { lookOut.appendChild(h('p', { cls: 'none card pad', text: 'No SEC registrant with a listed ticker matches “' + q + '”. Try the ticker, or the start of the legal name.' })); return; }
        var outside = r.matches.filter(function (m) { return !m.inSet; });
        if (r.matches.length === 1 && outside.length === 1) { location.hash = '#/x/' + outside[0].cik; return; }
        lookOut.appendChild(h('ul', { cls: 'rows card' }, r.matches.map(function (m) {
          return h('li', null, h('a', { href: m.inSet ? '#/c/' + m.inSet : '#/x/' + m.cik, cls: 'row' },
            h('span', { cls: 'tile', 'aria-hidden': 'true', text: m.name.replace(/[^A-Za-z]/g, '').slice(0, 2) }),
            h('span', { cls: 'row-main' }, h('span', { cls: 'row-t', text: m.name }), h('span', { cls: 'row-s', text: m.ticker + ' · ' + (m.inSet ? 'in the reviewed set' : 'look up on request') })),
            h('span', { cls: 'chev', 'aria-hidden': 'true', text: '›' })));
        })));
      }, function (e) {
        if (mine !== asked) return;
        clear(lookOut); lookOut.appendChild(h('p', { cls: 'none card pad', text: e.message }));
      });
    };
    lookBtn.addEventListener('click', doLookup);
    find.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } });
    find.addEventListener('input', function () {
      var q = find.value.trim().toLowerCase();
      asked += 1; clear(lookOut);
      lookBtn.hidden = q.length < 1;
      lookBtn.textContent = 'Look up “' + find.value.trim() + '” in SEC filings';
      var any = false;
      groupsEl.forEach(function (g) {
        var n = 0;
        g.rows.forEach(function (r) { var on = !q || r.key.indexOf(q) >= 0; r.li.hidden = !on; if (on) n += 1; });
        g.el.hidden = n === 0; if (n) any = true;
      });
      none.hidden = any;
    });
    var page = h('div', { cls: 'page' },
      h('section', { cls: 'hero center' },
        h('p', { cls: 'eyebrow', text: 'From public filings' }),
        h('h1', { text: 'What the filings say.' }),
        h('p', { cls: 'lede', text: data.companies.length + ' technology companies - the S&P 500’s information technology sector, with Amazon, Alphabet, Meta, TSMC and ASML - in their own reported numbers and their own words. Every figure opens its filing. Every relationship shows the exact quote.' }),
        h('div', { cls: 'cta' }, h('a', { cls: 'pill', href: '#/map', text: 'Open the map' }), h('a', { cls: 'pill line', href: '#/patterns', text: 'See the patterns' })),
        h('ul', { cls: 'stats' },
          h('li', null, h('strong', { text: String(data.companies.length) }), 'companies'),
          h('li', null, h('strong', { text: nFig.toLocaleString('en-US') }), 'reported figures'),
          h('li', null, h('strong', { text: String(data.edges.length) }), 'quoted relationships'))),
      h('div', { cls: 'find' }, h('label', { cls: 'ctl-l', for: 'find', text: 'Find a company, or look up any SEC filer' }), find), none,
      h('div', { cls: 'look' }, lookBtn, lookOut));
    var rec = recent();
    if (rec.length) {
      page.appendChild(h('section', { cls: 'group' },
        h('h2', { text: 'Looked up' }), h('p', { cls: 'group-sub', text: LABEL + ' · on this device' }),
        h('ul', { cls: 'rows card' }, rec.map(function (x) {
          return h('li', null, h('a', { href: '#/x/' + x.cik, cls: 'row' },
            h('span', { cls: 'tile looked', 'aria-hidden': 'true', text: x.name.replace(/[^A-Za-z]/g, '').slice(0, 2) }),
            h('span', { cls: 'row-main' }, h('span', { cls: 'row-t', text: x.name }), h('span', { cls: 'row-s', text: (x.ticker ? x.ticker + ' · ' : '') + 'looked up on request' })),
            h('span', { cls: 'chev', 'aria-hidden': 'true', text: '›' })));
        }))));
    }
    // Biggest names first: cloud, devices, chips, then the rest of the chain.
    var HOME_ORDER = ['cloud', 'devices', 'chips', 'software', 'equipment', 'components', 'services'];
    data.layers.filter(function (l) { return l.id !== 'lookup'; }).sort(function (a, b) { return HOME_ORDER.indexOf(a.id) - HOME_ORDER.indexOf(b.id); }).forEach(function (l) {
      var cs = data.companies.filter(function (c) { return c.layer === l.id; }).sort(function (a, b) {
        var fa = Core.fig(data, a.id, a.currency === 'TWD' ? 'revenueUsd' : 'revenue', a.latest); var fb = Core.fig(data, b.id, b.currency === 'TWD' ? 'revenueUsd' : 'revenue', b.latest);
        return (fb ? fb.v : 0) - (fa ? fa.v : 0);
      });
      if (!cs.length) return;
      var rows = [];
      var el = h('section', { cls: 'group' },
        h('h2', { text: l.name }), h('p', { cls: 'group-sub', text: l.blurb + ' · ' + cs.length + (cs.length === 1 ? ' company' : ' companies') }),
        h('ul', { cls: 'rows card' }, cs.map(function (c) {
          var rev = Core.fig(data, c.id, 'revenue', c.latest);
          var gm = Core.derived(data, c.id, 'grossMargin', c.latest);
          var li = h('li', null, h('a', { href: '#/c/' + c.id, cls: 'row' },
            h('span', { cls: 'tile', 'aria-hidden': 'true', text: c.name.replace(/[^A-Za-z]/g, '').slice(0, 2) }),
            h('span', { cls: 'row-main' }, h('span', { cls: 'row-t', text: c.name }), h('span', { cls: 'row-s', text: c.id + ' · FY' + c.latest + ' revenue ' + (rev ? Core.money(rev.v, c.currency) : 'n/a') + (gm ? ' · gross margin ' + Core.pct(gm.v, 0) : '') })),
            spark(c), h('span', { cls: 'chev', 'aria-hidden': 'true', text: '›' })));
          rows.push({ li: li, key: (c.name + ' ' + c.id + ' ' + c.legal).toLowerCase() });
          return li;
        })));
      groupsEl.push({ el: el, rows: rows });
      page.appendChild(el);
    });
    return page;
  }

  /* ---------------- one company ---------------- */

  /** A company whose history spans two SEC registrants (a re-domicile):
   *  which years were filed under the earlier one. Each figure still opens
   *  its own filing, under the CIK it was filed under. */
  function priorNote(c) {
    if (!c.prior) return null;
    return c.prior.map(function (p) {
      var fys = c.years.filter(function (fy) { var f = Core.fig(data, c.id, 'revenue', fy); return f && (data.filings[f.a] || {}).cik === p.cik; });
      if (!fys.length) return null;
      return h('p', { cls: 'note', text: 'FY' + fys[0] + (fys.length > 1 ? '–FY' + fys[fys.length - 1] : '') + ' were filed by ' + p.legal + ' (CIK ' + p.cik + '), the earlier registrant; each figure opens the filing it came from.' });
    });
  }
  function companyPage(id) {
    var c = Core.company(data, id);
    if (!c || !c.filer) return h('div', { cls: 'page' }, h('p', { cls: 'none', text: 'That company is not one of the ' + data.companies.length + ' here.' }), h('p', null, h('a', { href: '#/', text: 'All companies' })));
    var ins = data.insights[id] || [];
    var by = function (topic) { return ins.filter(function (x) { return x.topic === topic; }); };
    var src = data.sources[c.annual.source];
    var m = c.lookup ? meta[id] : null;
    var page = h('div', { cls: 'page' },
      h('p', { cls: 'crumb' }, h('a', { href: '#/', text: 'Companies' })),
      h('section', { cls: 'hero small' },
        c.lookup ? h('p', { cls: 'flag', text: LABEL }) : h('p', { cls: 'eyebrow', text: layerName(c.layer) }),
        h('h1', { text: c.name }),
        h('p', { cls: 'lede' }, c.legal + (c.ticker ? ' (' + c.ticker + ')' : '') + ' · reports in ' + (c.currency === 'USD' ? 'US dollars' : c.currency === 'EUR' ? 'euros' : c.currency === 'TWD' ? 'New Taiwan dollars' : c.currency) + ' · latest annual report: ', ext(src.url, 'Form ' + src.form + ' for the year ended ' + src.period), ', filed ' + src.date + '.'),
        m ? h('p', { cls: 'note', text: 'Read from sec.gov on ' + String(m.at).slice(0, 10) + (m.stale ? ' (sec.gov could not be reached for a newer copy)' : '') + ', by the same rules as the reviewed companies: every figure is a number the company tagged, and opens its filing. Nobody has checked this company by hand, and it is not part of the patterns or their sums.' }) : null,
        priorNote(c)));
    var grid = h('div', { cls: 'grid' });
    var pending = [];
    // The page in sections, so a phone is not one endless scroll: the annual
    // figures open, the rest closed until asked for. A section is drawn the
    // first time it opens (a chart needs its real width).
    var open = openSecs[id] = openSecs[id] || { annual: true };
    var nav = h('div', { cls: 'chips secnav', role: 'navigation', 'aria-label': 'Sections of this page' });
    page.appendChild(nav);
    var addSection = function (sid, title, sub, build) {
      var body = h('div', { cls: 'sec-body' });
      var det = h('details', { cls: 'sec', id: 's-' + sid }, h('summary', null, h('span', { cls: 'sec-t', text: title }), h('span', { cls: 'sec-s', text: sub })), body);
      var drawn = false;
      var fill = function () { if (drawn) return; drawn = true; var after = build(body); if (after) after(); };
      det.addEventListener('toggle', function () { open[sid] = det.open; if (det.open) fill(); });
      if (open[sid]) { det.open = true; pending.push(fill); }
      nav.appendChild(h('button', { type: 'button', cls: 'chip', text: title, on: { click: function () { det.open = true; fill(); det.scrollIntoView({ block: 'start' }); } } }));
      page.appendChild(det);
    };
    addSection('annual', 'Annual figures', 'Revenue, margins, spending, inventory, customers', function (body) {
      body.appendChild(grid);
      var later = [];
      ANNUAL_DEFS(id).forEach(function (d) { grid.appendChild(chartCard(c, d, by(d.topic), later)); });
      annualExtras();
      return function () { later.forEach(function (f) { f(); }); };
    });
    addSection('cash', 'Cash', 'Free cash flow, pay in stock, repurchases, dividends, cash and debt', function (body) { return cashSection(c, body); });
    addSection('quarter', 'Latest quarter', 'The newest three months and the last four quarters, from 10-Qs', function (body) { return quarterSection(c, body); });
    addSection('people', 'Backlog & people', 'Revenue under contract, deferred revenue, employees, flagged charges', function (body) { return peopleSection(c, body); });
    addSection('peers', 'Peers', 'Rank among filers that share its SIC code', function (body) { peersSection(c, body); });
    var annualExtras = function () {
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
    };
    var mine = data.edges.filter(function (e) { return e.from === id || e.to === id; });
    page.appendChild(h('section', { cls: 'group', id: 's-named' },
      h('h2', { text: 'Named in the filings' }),
      h('p', { cls: 'group-sub', text: 'Relationships a primary document states, with ' + c.name + ' on one side. Tap one for the exact words.' }),
      mine.length ? edgeRows(mine) : (m && !m.relations ? null : h('p', { cls: 'none card pad', text: m ? 'No sentence in ' + c.name + '’s latest annual report passed the check, and no reviewed document names it.' : 'No document in this set names a relationship with ' + c.name + '.' })),
      m ? relationsBox(c, m) : null,
      h('p', { cls: 'more' }, h('a', { cls: 'pill' + (m ? ' line' : ''), href: '#/map/' + id, text: 'Follow ' + c.name + ' on the map' }))));
    nav.appendChild(h('button', { type: 'button', cls: 'chip', text: 'Named in the filings', on: { click: function () { document.getElementById('s-named').scrollIntoView({ block: 'start' }); } } }));
    page._after = function () { pending.forEach(function (f) { f(); }); };
    return page;
  }

  var openSecs = {};     // company id -> which sections of its page are open
  function ANNUAL_DEFS(id) {
    return [
      { topic: 'revenue', title: 'Revenue', kind: 'bar', get: function (fy) { var f = Core.fig(data, id, 'revenue', fy); return f ? { v: f.v, cites: [id + '.revenue.' + fy] } : null; }, money: true },
      { topic: 'margin', title: 'Gross margin', kind: 'line', get: function (fy) { return Core.derived(data, id, 'grossMargin', fy); } },
      { topic: 'rd', title: 'R&D as a share of revenue', kind: 'line', get: function (fy) { return Core.derived(data, id, 'rdIntensity', fy); } },
      { topic: 'capex', title: 'Capital spending', kind: 'bar', get: function (fy) { var f = Core.fig(data, id, 'capex', fy); return f ? { v: f.v, cites: [id + '.capex.' + fy] } : null; }, money: true },
      { topic: 'inventory', title: 'Inventory days', kind: 'line', days: true, get: function (fy) { return Core.derived(data, id, 'inventoryDays', fy); } },
    ];
  }
  /** One measure over the company's fiscal years: the latest value, its
   *  sentences, a chart (drawn by the function pushed to `later`, once the
   *  card is on the page) and the same numbers as a table. */
  function chartCard(c, d, sentences, later) {
    var points = c.years.map(function (fy) { var x = d.get(fy); return { fy: fy, v: x ? x.v : null, cites: x ? x.cites : [] }; });
    var have = points.filter(function (p) { return p.v !== null; });
    var fmt = d.money ? function (v) { return Core.money(v, c.currency); } : d.days ? function (v) { return Math.round(v) + ' days'; } : function (v) { return Core.pct(v, 1); };
    var tick = d.money ? function (v) { return Core.money(v, c.currency, true); } : d.days ? function (v) { return String(Math.round(v)); } : function (v) { return Core.pct(v, 0); };
    var latest = have.length ? have[have.length - 1] : null;
    var host = h('div', { cls: 'chart-host' });
    if (have.length) later.push(function () { seriesChart(host, { title: d.title, kind: d.kind, points: points, years: c.years, fmt: fmt, tick: tick }); });
    return h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: d.title }),
      latest ? h('p', { cls: 'big' }, h('span', { text: fmt(latest.v) }), h('span', { cls: 'big-s', text: ' FY' + latest.fy })) : h('p', { cls: 'none', text: d.none || 'Not tagged in this company’s filings.' }),
      d.note && latest ? h('p', { cls: 'note', text: d.note }) : null,
      sentences.map(sentence), host,
      have.length ? tableOf(['Fiscal year', d.title, 'Source'], have.map(function (p) { return ['FY' + p.fy, fmt(p.v), srcButton(p.cites.length > 1 ? p.cites.length + ' filings' : 'Filing', d.title + ', FY' + p.fy, p.cites)]; })) : null);
  }
  /** A list of facts: a label, a value (or "Not tagged"), and its sources. */
  function factRows(rows) {
    return h('ul', { cls: 'facts' }, rows.map(function (r) {
      return h('li', null,
        h('span', { cls: 'fact-l' }, r.label, r.sub ? h('span', { cls: 'sub', text: ' ' + r.sub }) : null),
        r.value === null ? h('span', { cls: 'fact-v none-v', text: r.none || 'Not tagged' }) : h('span', { cls: 'fact-v', text: r.value }),
        r.value !== null && r.cites && r.cites.length ? srcButton(r.cites.length === 1 ? 'Source' : r.cites.length + ' sources', r.label, r.cites) : h('span', { cls: 'fact-x' }));
    }));
  }

  /* ---------------- the latest quarter ---------------- */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function quarterSection(c, body) {
    var id = c.id;
    var v = Core.quarterView(data, id);
    if (!v) {
      body.appendChild(h('p', { cls: 'none card pad', text: 'No quarterly report (Form 10-Q) with tagged revenue is on file for ' + c.name + '.' + (c.form === '20-F' ? ' It files its annual report on Form 20-F; a company that does is not required to file 10-Qs, and its interim reports (Form 6-K) are not tagged.' : '') }));
      return null;
    }
    var fs = data.finsights[id] || [];
    var by = function (topic) { return fs.filter(function (x) { return x.topic === topic; }); };
    var M = function (x) { return Core.money(x, c.currency); };
    var NAMES = { revenue: 'Revenue', opinc: 'Operating income', netinc: 'Net income', ocf: 'Operating cash flow', capex: 'Capital spending', fcf: 'Free cash flow' };
    var row = function (set, k) {
      var q = set[k];
      var how = !q ? '' : k === 'fcf' ? 'operating cash flow less capital spending · ' + Core.computedFrom(q.cites.length) : q.how && q.how !== 'as filed' ? q.how + ' · ' + Core.computedFrom(q.cites.length) : q.cites.length > 1 ? Core.computedFrom(q.cites.length) : 'as filed';
      return { label: NAMES[k], sub: how, value: q ? M(q.v) : null, cites: q ? q.cites : [] };
    };
    var keys = ['revenue', 'opinc', 'netinc', 'ocf', 'capex', 'fcf'];
    var grid = h('div', { cls: 'grid' });
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Three months ended ' + v.end }),
      by('quarter').map(sentence),
      factRows(keys.map(function (k) { return row(v.q, k); }))));
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Four quarters to ' + v.end }),
      by('ttm').map(sentence),
      factRows(keys.map(function (k) { return row(v.ttm, k); })),
      h('p', { cls: 'note', text: 'A quarterly report tags some numbers for the three months and others only for the year so far. Where there is no three-month figure, the quarter is one filed year-to-date figure less the one a quarter earlier, and the fourth quarter is the fiscal year less its first nine months; each says so and opens every figure it uses. Four quarters are added up only when all four are there.' })));
    var later = [];
    var list = v.lists.revenue;
    var ends = list.map(function (q) { return q.end; });
    var host = h('div', { cls: 'chart-host' });
    var fmt = M; var tick = function (x) { return Core.money(x, c.currency, true); };
    var xl = function (e) { return MONTHS[Number(e.slice(5, 7)) - 1] + ' ’' + e.slice(2, 4); };
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Revenue by quarter' }),
      h('p', { cls: 'big' }, h('span', { text: fmt(list[list.length - 1].v) }), h('span', { cls: 'big-s', text: ' ' + xl(v.end) })),
      host,
      tableOf(['Three months ended', 'Revenue', 'How', 'Source'], list.slice().reverse().map(function (q) { return [q.end, fmt(q.v), q.how, srcButton(q.cites.length > 1 ? q.cites.length + ' figures' : 'Filing', 'Revenue, three months ended ' + q.end, q.cites)]; }))));
    if (list.length > 1) later.push(function () { seriesChart(host, { title: 'Revenue', kind: 'bar', points: list.map(function (q) { return { fy: q.end, v: q.v, cites: q.cites }; }), years: ends, fmt: fmt, tick: tick, xlabel: xl, plabel: function (e) { return 'Three months ended ' + e; }, xwidth: 52 }); });
    body.appendChild(grid);
    return function () { later.forEach(function (f) { f(); }); };
  }

  /* ---------------- backlog and people ---------------- */

  function peopleSection(c, body) {
    var id = c.id; var L = c.latest;
    var fs = data.finsights[id] || [];
    var by = function (topic) { return fs.filter(function (x) { return x.topic === topic; }); };
    var M = function (v) { return Core.money(v, c.currency); };
    var one = function (m, label, sub) {
      var f = Core.fig(data, id, m, L);
      return { label: label, sub: (sub || '') + (f && m === 'deferred' ? 'tagged ' + f.tag.replace(/^.*:/, '') : ''), value: f ? (f.v === 0 && (m === 'impairment' || m === 'restructuring') ? 'Tagged as zero' : M(f.v)) : null, cites: f ? [id + '.' + m + '.' + L] : [] };
    };
    var q = (data.quotes || {})[id + '.q.employees'];
    var per = Core.derived(data, id, 'revenuePerEmployee', L);
    var grid = h('div', { cls: 'grid' });
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Revenue still to come, end of FY' + L }),
      by('backlog').map(sentence),
      factRows([one('rpo', 'Remaining performance obligations', 'revenue under contract, not yet recognised'), one('deferred', 'Deferred revenue', '')]),
      h('p', { cls: 'note', text: 'Both are balances the company tagged at its year end. They say what was under contract or already billed on that day - not what revenue is going to be.' })));
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Employees' }),
      q ? [h('p', { cls: 'big' }, h('span', { text: Core.commas(q.n) }), h('span', { cls: 'big-s', text: ' as the latest annual report states' })),
        h('blockquote', null, '“' + q.quote + '”'),
        by('people').map(sentence),
        factRows([{ label: 'Revenue for each employee', sub: per ? 'FY' + L + ' revenue ÷ that number · computed' : '', value: per ? 'about ' + Core.perHead(per.v, c.currency) : null, cites: per ? per.cites : [] }])]
        : h('p', { cls: 'none', text: c.lookup ? 'The automatic reader found no sentence in the latest annual report that states the number of employees plainly. None is shown.' : 'No sentence in the latest annual report states the number of employees in a form that could be quoted with its number. None is shown.' })));
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Flagged charges, FY' + L }),
      by('flags').map(sentence),
      factRows([one('impairment', 'Goodwill impairment'), one('restructuring', 'Restructuring charges')]),
      h('p', { cls: 'note', text: 'Shown when the annual report tags them. “Not tagged” is not the same as none.' })));
    body.appendChild(grid);
    return null;
  }

  /* ---------------- peers ----------------
   * data/sic/<code>.json: every registrant that meets the definition, with
   * the filing each of its figures was read from. Ranks are worked out here,
   * by AsFiledCore, from that file alone. */

  function peersSection(c, body) {
    if (!c.sic) { body.appendChild(h('p', { cls: 'none card pad', text: 'No SIC code is recorded for ' + c.name + ', so no peer group can be named.' })); return; }
    var wait = h('p', { cls: 'loading', role: 'status', text: 'Loading the peer list…' });
    body.appendChild(wait);
    load('sic/' + c.sic).then(function (part) {
      clear(body);
      var R = Core.peerRanks(part, c.cik);
      var fmt = function (m, v) { return m.money ? Core.money(v, 'USD') : Core.pct(v, 1); };
      var inSet = {}; data.companies.forEach(function (x) { inSet[x.cik] = x.id; });
      var byCik = {}; part.peers.forEach(function (p) { byCik[p.cik] = p; });
      var showList = function (m) {
        openSheet(m.label + ' · SIC ' + part.sic, [
          h('p', { cls: 'src-l', text: m.rows.length + ' of the ' + part.peers.length + ' registrants have the tagged figures for this (' + m.how + '), highest first. Each figure is the one in the filing linked beside it.' }),
          h('ol', { cls: 'peerlist' }, m.rows.map(function (r, i) {
            var p = byCik[r.cik];
            var name = inSet[r.cik] ? h('a', { href: '#/c/' + inSet[r.cik], text: r.name }) : p.t ? h('a', { href: '#/x/' + r.cik, text: r.name }) : h('span', { text: r.name });
            return h('li', { cls: r.cik === c.cik ? 'me' : null },
              h('div', { cls: 'bar-top' }, h('span', { cls: 'bar-l' }, (i + 1) + '. ', name), h('span', { cls: 'bar-v', text: fmt(m, r.v) })),
              Core.peerCites(part, p, m.key).map(function (x) {
                return h('p', { cls: 'peer-src' }, x.tag.replace(/^.*:/, '') + ' ' + Core.money(x.v, 'USD') + ' · year ended ' + x.end + ' · ', ext(x.url, 'Form ' + (x.what === 'revenue0' || x.accn !== p.a[0] ? '' : p.form + ' ') + x.accn));
              }));
          }))]);
      };
      var st = R.me ? Core.peerSentence(part, c.name, R) : null;
      var rows = R.metrics.filter(function (m) { return m.rows.length && (m.key !== 'rdShare' || !R.me || m.rank); });
      body.appendChild(h('section', { cls: 'card pad' },
        h('h2', { cls: 'card-t', text: 'SIC code ' + part.sic + ' · ' + part.desc }),
        st ? h('p', { cls: 'say', text: st }) : h('p', { cls: 'none', text: c.name + ' is not in this list: ' + (c.currency !== 'USD' ? 'it reports in ' + c.currency + ', and the comparison is in US dollars.' : 'it has no revenue figure in US dollars in the SEC’s frame for calendar ' + part.frame.slice(2) + ' (the SEC assigns each fiscal year to one calendar year, and a 53-week year can skip one), or no Form 10-K or 20-F filed since ' + part.since + '.') }),
        h('ul', { cls: 'facts' }, rows.map(function (m) {
          return h('li', null,
            h('span', { cls: 'fact-l' }, m.label, h('span', { cls: 'sub', text: m.rank ? fmt(m, m.v) + (R.me ? ' · year ended ' + R.me.end : '') : m.rows.length + ' registrants' })),
            m.rank ? h('span', { cls: 'fact-v', text: m.text }) : h('span', { cls: 'fact-v none-v', text: R.me ? 'Not tagged' : '' }),
            h('button', { type: 'button', cls: 'cite', 'aria-label': m.label + ': the list of ' + m.rows.length + ' registrants and their filings', on: { click: function () { showList(m); } } }, 'All ' + m.rows.length));
        })),
        R.me && R.me.end !== c.annual.period ? h('p', { cls: 'note', text: 'The SEC’s frame for calendar ' + part.frame.slice(2) + ' holds ' + c.name + '’s fiscal year ended ' + R.me.end + '. Its latest annual report is for the year ended ' + c.annual.period + ', which the SEC assigns to another calendar year.' }) : null,
        h('p', { cls: 'note', text: Core.peerDefinition(part) }),
        h('p', { cls: 'note', text: 'A peer’s figure is the latest one it filed for the period (the SEC’s frames), read ' + part.read + '; a restated figure can differ from the as-first-filed figure in the sections above. A rank is a position in a list of filed figures, nothing more.' })));
    }, function () {
      clear(body);
      body.appendChild(h('p', { cls: 'none card pad', text: 'No peer list is published for SIC code ' + c.sic + ': no registrant with that code met the definition when the lists were built.' }));
    });
  }

  /* ---------------- cash and capital return ---------------- */

  function cashSection(c, body) {
    var id = c.id; var L = c.latest;
    var fs = data.finsights[id] || [];
    var by = function (topic) { return fs.filter(function (x) { return x.topic === topic; }); };
    var M = function (v) { return Core.money(v, c.currency); };
    var one = function (m, label, sub) { var f = Core.fig(data, id, m, L); return { label: label, sub: sub, value: f ? M(f.v) : null, cites: f ? [id + '.' + m + '.' + L] : [] }; };
    var der = function (name, label, sub, fmt) { var d = Core.derived(data, id, name, L); return { label: label, sub: d ? (sub ? sub + ' · ' : '') + Core.computedFrom(d.cites.length) : sub, value: d ? (fmt || M)(d.v) : null, cites: d ? d.cites : [], none: 'Not tagged' }; };
    var debt = Core.derived(data, id, 'debt', L);
    var grid = h('div', { cls: 'grid' });
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Cash in FY' + L + ', as tagged' }),
      factRows([
        one('ocf', 'Operating cash flow'),
        one('capex', 'Capital spending'),
        der('fcf', 'Free cash flow', ''),
        one('sbc', 'Stock-based compensation'),
        der('sbcShare', 'Stock-based compensation, share of revenue', '', function (v) { return Core.pct(v, 1); }),
        one('buybacks', 'Share repurchases'),
        one('dividends', 'Dividends paid'),
        one('cash', 'Cash and cash equivalents', 'at year end'),
        one('sti', 'Short-term investments', 'at year end'),
        der('debt', 'Debt, as tagged', debt ? debt.how : 'current and long-term'),
        der('netDebt', 'Debt less cash', ''),
      ]),
      h('p', { cls: 'note', text: 'Each line is a number the company tagged in its annual report, or is worked out from such numbers and says so. “Not tagged” means no figure under the tags this app reads - not zero. Debt is the sum of the balance-sheet tags named beside it and nothing else; a borrowing tagged another way is not in it.' })));
    var later = [];
    grid.appendChild(chartCard(c, { title: 'Free cash flow', kind: 'bar', money: true, get: function (fy) { return Core.derived(data, id, 'fcf', fy); }, note: 'Computed from two filed figures: operating cash flow less capital spending. Each year opens both.', none: 'Operating cash flow and capital spending are not both tagged.' }, by('fcf'), later));
    grid.appendChild(chartCard(c, { title: 'Stock-based compensation, share of revenue', kind: 'line', get: function (fy) { return Core.derived(data, id, 'sbcShare', fy); } }, by('sbc'), later));
    var ret = c.years.map(function (fy) { return { fy: fy, b: Core.fig(data, id, 'buybacks', fy), d: Core.fig(data, id, 'dividends', fy) }; }).filter(function (r) { return r.b || r.d; });
    grid.appendChild(h('section', { cls: 'card pad' },
      h('h2', { cls: 'card-t', text: 'Repurchases and dividends' }),
      ret.length ? [by('returns').map(sentence), h('div', { cls: 'scroll' }, h('table', null,
        h('thead', null, h('tr', null, ['Fiscal year', 'Share repurchases', 'Dividends paid', 'Source'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', null, ret.slice().reverse().map(function (r) {
          var cites = [].concat(r.b ? [id + '.buybacks.' + r.fy] : [], r.d ? [id + '.dividends.' + r.fy] : []);
          return h('tr', null, h('th', { scope: 'row', text: 'FY' + r.fy }), h('td', { text: r.b ? M(r.b.v) : 'Not tagged' }), h('td', { text: r.d ? M(r.d.v) : 'Not tagged' }), h('td', null, srcButton(cites.length > 1 ? '2 filings' : 'Filing', 'Repurchases and dividends, FY' + r.fy, cites)));
        }))))] : h('p', { cls: 'none', text: 'Not tagged in this company’s filings.' })));
    var debtS = by('debt');
    if (debtS.length) grid.appendChild(h('section', { cls: 'card pad' }, h('h2', { cls: 'card-t', text: 'Cash and debt at the end of FY' + L }), debtS.map(sentence)));
    body.appendChild(grid);
    return function () { later.forEach(function (f) { f(); }); };
  }

  /* ---------------- relationships for a looked-up company ----------------
   * Asked for by a signed-in member. The server shows a model sentences
   * from the company's own annual report and keeps only the quotes that
   * pass the same word-for-word check as the reviewed set. */

  function relationsBox(c, m) {
    var box = h('div', { cls: 'card pad rel' });
    var rel = m.relations;
    if (rel) {
      var st = rel.stats; var dropped = st.proposed - st.kept;
      add(box, [
        h('p', { cls: 'say', text: 'A model was shown ' + st.sent + (st.sent === 1 ? ' sentence' : ' sentences') + ' from the latest annual report that name another company. It proposed ' + st.proposed + (st.proposed === 1 ? ' relationship' : ' relationships') + '; ' + st.kept + ' passed the word-for-word check against the report' + (dropped > 0 ? ' and ' + dropped + (dropped === 1 ? ' was' : ' were') + ' dropped' : '') + '.' }),
        h('p', { cls: 'note', text: 'The model only points at sentences. A relationship is shown only when its quote is in the report exactly, names the other company, and the report is ' + c.name + '’s own. Read ' + String(new Date(rel.at).toISOString()).slice(0, 10) + '.' })]);
      var also = rel.nodes.filter(function (n) { return n.cik; });
      if (also.length) {
        box.appendChild(h('div', { cls: 'also' }, also.map(function (n) {
          var full = Core.company(data, n.id);
          return h('a', { cls: 'pill ghost', href: '#/x/' + n.cik, text: (n.present || (full && full.filer) ? n.name + '’s figures' : 'Also look up ' + n.name) });
        })));
      }
      return box;
    }
    var steps = h('ol', { cls: 'steps', 'aria-live': 'polite' });
    var msg = h('p', { cls: 'note', 'aria-live': 'polite' });
    var btn = h('button', { type: 'button', cls: 'pill', text: 'Find relationships' });
    var run = function () {
      if (!me || !me.signedIn) { signIn(run); return; }
      btn.disabled = true; btn.textContent = 'Reading the annual report…'; msg.textContent = 'This can take a minute or two. Keep this page open.'; clear(steps);
      var fail = function (text) { btn.disabled = false; btn.textContent = 'Find relationships'; msg.textContent = text; };
      var take = function (o) {
        if (o.step) steps.appendChild(h('li', { text: o.step }));
        if (o.error) fail(o.error);
        if (o.done) { mergeRelations(c.id, o.relations); route(); }
      };
      request('api/lookup/' + m.cik + '/relations', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (r) {
        if (r.status === 401) { me = { signedIn: false }; btn.disabled = false; btn.textContent = 'Find relationships'; msg.textContent = ''; signIn(run); return null; }
        if (!r.ok || !r.body || !/ndjson/.test(r.headers.get('content-type') || '')) return r.json().then(function (j) { if (r.ok) take(j); else fail((j.error || 'That did not work.') + (j.detail ? ' ' + j.detail : '')); });
        var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = ''; var ended = false;
        var pump = function () {
          return reader.read().then(function (x) {
            buf += x.done ? '' : dec.decode(x.value, { stream: true });
            var lines = buf.split('\n'); buf = x.done ? '' : lines.pop();
            lines.forEach(function (l) { if (!l.trim()) return; try { var o = JSON.parse(l); if (o.done || o.error) ended = true; take(o); } catch (e) { /* a broken line is skipped */ } });
            if (x.done) { if (!ended) fail('The connection ended before the answer arrived. Try again: a finished run is kept.'); return null; }
            return pump();
          });
        };
        return pump();
      }).catch(function () { fail('That did not work. Check the connection and try again.'); });
    };
    btn.addEventListener('click', run);
    add(box, [
      h('p', { cls: 'say', text: 'Nobody has read ' + c.name + '’s annual report for this app. You can ask for it to be read now.' }),
      h('p', { cls: 'note', text: 'A model (Claude) is shown the sentences that name another company and picks the ones that state a competitor, customer, supplier or partner. Every quote it gives is then checked against the report word for word; anything that does not match is dropped. Signed-in members only - it uses the Lab’s AI allowance.' }),
      h('p', { cls: 'more' }, btn), steps, msg]);
    if (me === null) loadMe().then(function () { if (!me.signedIn && !btn.disabled) btn.textContent = 'Sign in to find relationships'; });
    else if (!me.signedIn) btn.textContent = 'Sign in to find relationships';
    return box;
  }
  /** The shared account's sign-in, in the sheet. `then` runs once signed in. */
  function signIn(then) {
    var email = h('input', { type: 'email', id: 'si-email', cls: 'input wide-input', autocomplete: 'email', required: true });
    var pass = h('input', { type: 'password', id: 'si-pass', cls: 'input wide-input', autocomplete: 'current-password', required: true, minlength: 8 });
    var err = h('p', { cls: 'note', role: 'alert' });
    var go = function (path) {
      return function (ev) {
        ev.preventDefault();
        err.textContent = '';
        api('POST', 'api/auth/' + path, { email: email.value, password: pass.value }).then(loadMe).then(function () { sheet.close(); if (then) then(); }, function (e) { err.textContent = e.message; });
      };
    };
    var form = h('form', { cls: 'signin', on: { submit: go('login') } },
      h('p', { cls: 'src-l', text: 'One account works across the Lab. Finding relationships uses its AI allowance.' }),
      h('label', { cls: 'ctl-l', for: 'si-email', text: 'Email' }), email,
      h('label', { cls: 'ctl-l', for: 'si-pass', text: 'Password' }), pass, err,
      h('div', { cls: 'cta' }, h('button', { type: 'submit', cls: 'pill', text: 'Sign in' }), h('button', { type: 'button', cls: 'pill line', text: 'Create an account', on: { click: go('register') } })));
    openSheet('Sign in', form);
  }

  function family(type) { return type === 'competitor' ? 'rival' : type === 'partner' ? 'tie' : 'supply'; }
  function pairTitle(e) { return nameOf(e.from) + (Core.DIRECTED[e.type] ? ' → ' : ' · ') + nameOf(e.to); }
  function verb(e) {
    return { supplier: 'supplies', customer: 'sells to', service: 'provides a service or platform to', auditor: 'is named as the auditor of', partner: 'partners with', competitor: 'is named as a competitor by' }[e.type];
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
        h('span', { cls: 'row-main' }, h('span', { cls: 'row-t', text: edgeLine(e) }), h('span', { cls: 'row-s', text: Core.TYPE_NAMES[e.type] + ' · said by ' + nameOf(e.by) + ' · ' + e.section + (e.lookup ? ' · looked up on request' : '') })),
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
      var key = (fam === 'supply' ? e.from + '>' + e.to : [e.from, e.to].sort().join('~')) + '|' + fam;
      if (!out[key]) { out[key] = { key: key, from: e.from, to: e.to, fam: fam, directed: fam === 'supply', edges: [] }; list.push(out[key]); }
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
  function revenueOf(c) {
    if (!c.filer) return 0;
    var f = Core.fig(data, c.id, c.currency === 'TWD' ? 'revenueUsd' : 'revenue', c.latest);
    return f ? f.v : 0;
  }
  function degrees(gs) {
    var d = {};
    gs.forEach(function (g) { d[g.from] = (d[g.from] || 0) + 1; d[g.to] = (d[g.to] || 0) + 1; });
    return d;
  }
  /** Which companies the map shows: around the followed company, or the
   *  most-linked ones, or every company in the layers that are on. */
  function shownSet(gs, deg) {
    var set = {}; var f = mapState.focus;
    var inLayer = function (c) { return c && mapState.layers[c.layer]; };
    if (f) {
      set[f] = true;
      gs.forEach(function (g) { if (g.from === f) set[g.to] = true; if (g.to === f) set[g.from] = true; });
      var fl = flow(f);
      Object.keys(fl.up).concat(Object.keys(fl.down)).forEach(function (id) { if (inLayer(Core.company(data, id))) set[id] = true; });
      return set;
    }
    if (mapState.scope === 'all') {
      data.companies.concat(data.lookups.filter(function (c) { return c.filer; })).forEach(function (c) { if (inLayer(c)) set[c.id] = true; });
      Object.keys(deg).forEach(function (id) { set[id] = true; });
      return set;
    }
    Object.keys(deg).sort(function (a, b) { return deg[b] - deg[a] || nameOf(a).localeCompare(nameOf(b)); }).slice(0, top()).forEach(function (id) { set[id] = true; });
    return set;
  }
  function fit(name, px) {
    var n = Math.max(4, Math.floor(px / 6.4));
    return name.length <= n ? name : name.slice(0, n - 1) + '…';
  }
  function drawMap(host, gs, shown, deg) {
    clear(host);
    var W = Math.max(280, host.clientWidth);
    var wide = W >= 760;
    var max = Math.max.apply(null, data.companies.map(revenueOf));
    var all = data.companies.concat(data.others, data.lookups);
    var cols = data.layers.filter(function (l) { return mapState.layers[l.id]; }).map(function (l) {
      var cs = all.filter(function (c) { return c.layer === l.id && shown[c.id]; });
      cs.sort(function (a, b) { return (b.filer ? 1 : 0) - (a.filer ? 1 : 0) || (deg[b.id] || 0) - (deg[a.id] || 0) || revenueOf(b) - revenueOf(a); });
      return { l: l, cs: cs };
    }).filter(function (x) { return x.cs.length; });
    var pos = {}; var H = 0; var heads = [];
    var radius = function (c, k) { return c.filer ? (5 + 13 * Math.sqrt(Math.min(1, revenueOf(c) / max))) * k : 4.5; };
    if (wide) {
      var cw = W / cols.length;
      cols.forEach(function (x, i) {
        var two = x.cs.length > 8 && cw >= 130;
        heads.push({ x: cw * i + cw / 2, y: 22, text: x.l.name });
        x.cs.forEach(function (c, j) {
          var cx = two ? cw * i + cw * (j % 2 ? 0.73 : 0.27) : cw * i + cw / 2;
          var y = 66 + (two ? j * 31 : j * 62);
          pos[c.id] = { x: cx, y: y, c: c, r: radius(c, 1), lw: two ? cw * 0.52 : cw * 0.9 };
          H = Math.max(H, y + 40);
        });
      });
    } else {
      var per = W >= 400 ? 4 : 3; var cellW = W / per; var y = 0;
      cols.forEach(function (x) {
        heads.push({ x: 12, y: y + 22, text: x.l.name, left: true });
        y += 34;
        x.cs.forEach(function (c, j) {
          pos[c.id] = { x: cellW * (j % per) + cellW / 2, y: y + Math.floor(j / per) * 66 + 26, c: c, r: radius(c, 0.85), lw: cellW * 0.94 };
        });
        y += Math.ceil(x.cs.length / per) * 66 + 10;
      });
      H = y;
    }
    var svg = s('svg', { cls: 'map', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': 'Map of stated relationships. Lines and companies are buttons; the same content is in the list view.' });
    var defs = s('defs');
    ['supply', 'tie'].forEach(function (f) { defs.appendChild(s('marker', { id: 'arr-' + f, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, s('path', { cls: 'arr m-' + f, d: 'M0 0L10 5L0 10z' }))); });
    svg.appendChild(defs);
    if (wide) cols.forEach(function (x, i) { if (i) svg.appendChild(s('line', { cls: 'grid', x1: r1((W / cols.length) * i), x2: r1((W / cols.length) * i), y1: 8, y2: H - 8 })); });
    var gHeads = s('g');
    heads.forEach(function (hd) { gHeads.appendChild(s('text', { cls: 'm-head', x: hd.x, y: hd.y, 'text-anchor': hd.left ? 'start' : 'middle', text: hd.text })); });
    var fl = mapState.focus && pos[mapState.focus] ? flow(mapState.focus) : null;
    var inFlow = function (id) { return fl && (id === mapState.focus || fl.up[id] || fl.down[id]); };
    var gEdges = s('g'); var gHits = s('g'); var gNodes = s('g');
    gs.forEach(function (g) {
      var a = pos[g.from]; var b = pos[g.to];
      if (!a || !b) return;
      var dx = b.x - a.x; var dy = b.y - a.y; var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var x1 = a.x + (dx / dist) * (a.r + 2); var y1 = a.y + (dy / dist) * (a.r + 2);
      var x2 = b.x - (dx / dist) * (b.r + 5); var y2 = b.y - (dy / dist) * (b.r + 5);
      var bend = g.fam === 'rival' ? 0.18 : g.fam === 'tie' ? -0.14 : 0.06;
      var mxp = (x1 + x2) / 2 - (y2 - y1) * bend; var myp = (y1 + y2) / 2 + (x2 - x1) * bend;
      var d = 'M' + r1(x1) + ' ' + r1(y1) + 'Q' + r1(mxp) + ' ' + r1(myp) + ' ' + r1(x2) + ' ' + r1(y2);
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
      var g = s('g', { cls: 'node' + (c.filer ? '' : ' other') + (c.lookup ? ' looked' : '') + (dim ? ' dim' : '') + (id === mapState.focus ? ' focus' : ''), tabindex: 0, role: 'button', 'aria-pressed': id === mapState.focus ? 'true' : 'false', 'aria-label': c.name + (c.lookup ? ' (looked up on request; not in the reviewed set)' : c.filer ? '' : ' (not in the set; named by others)') + ', ' + (deg[id] || 0) + ' stated ' + ((deg[id] || 0) === 1 ? 'link' : 'links') + ' shown. Follow the flow from here.' },
        s('circle', { cx: r1(p.x), cy: r1(p.y), r: r1(p.r) }),
        s('text', { cls: c.filer ? null : 'small', x: r1(p.x), y: r1(p.y + p.r + 13), 'text-anchor': 'middle', text: fit(c.name, p.lw) }),
        s('rect', { cls: 'nhit', x: r1(p.x - 22), y: r1(p.y - 22), width: 44, height: 44 }));
      var go = function () { mapState.focus = mapState.focus === id ? null : id; renderMapPart(); };
      g.addEventListener('click', go);
      g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      gNodes.appendChild(g);
    });
    svg.appendChild(gEdges); svg.appendChild(gHeads); svg.appendChild(gNodes); svg.appendChild(gHits);
    host.appendChild(svg);
  }
  var renderMapPart = function () {};
  function findCompany(q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return null;
    var all = data.companies.concat(data.others, data.lookups);
    var exact = all.filter(function (c) { return c.name.toLowerCase() === q || c.id.toLowerCase() === q; })[0];
    if (exact) return exact;
    var part = all.filter(function (c) { return c.name.toLowerCase().indexOf(q) === 0 || (c.legal || '').toLowerCase().indexOf(q) === 0; });
    return part.length === 1 ? part[0] : null;
  }
  function mapPage(focus) {
    if (!Object.keys(mapState.layers).length) data.layers.forEach(function (l) { mapState.layers[l.id] = true; });
    if (data.lookups.length && mapState.layers.lookup === undefined) mapState.layers.lookup = true;
    if (focus && Core.company(data, focus)) {
      mapState.focus = focus;
      // A looked-up company's links are mostly "competitor, as stated":
      // following it turns that chip on, or its map would be empty.
      if (Core.company(data, focus).lookup) mapState.types.competitor = true;
    }
    var host = h('div', { cls: 'map-host' });
    var listHost = h('div', { cls: 'list-host' });
    var info = h('div', { cls: 'flow-info', 'aria-live': 'polite' });
    var scopeNote = h('p', { cls: 'note pad scope-note', 'aria-live': 'polite' });
    var chip = function (label, on, fn, extra) { return h('button', { type: 'button', cls: 'chip' + (extra ? ' ' + extra : ''), 'aria-pressed': on ? 'true' : 'false', on: { click: fn } }, label); };
    var typeBar = h('div', { cls: 'chips', role: 'group', 'aria-label': 'Relationship types' });
    var layerBar = h('div', { cls: 'chips', role: 'group', 'aria-label': 'Layers' });
    var scopeBar = h('div', { cls: 'seg', role: 'group', 'aria-label': 'Which companies' });
    var viewBar = h('div', { cls: 'seg', role: 'group', 'aria-label': 'View' });
    var dl = h('datalist', { id: 'co-list' });
    data.companies.concat(data.others, data.lookups).forEach(function (c) { dl.appendChild(h('option', { value: c.name })); });
    var search = h('input', { type: 'search', id: 'flow', cls: 'input wide-input', list: 'co-list', placeholder: 'Search ' + (data.companies.length + data.others.length) + ' companies', autocomplete: 'off', spellcheck: 'false' });
    var miss = h('p', { cls: 'note', 'aria-live': 'polite' });
    var pickFrom = function () {
      var q = search.value;
      if (!q.trim()) { if (mapState.focus) { mapState.focus = null; renderMapPart(); } miss.textContent = ''; return; }
      var c = findCompany(q);
      if (!c) { miss.textContent = 'No company here matches “' + q.trim() + '”.'; return; }
      miss.textContent = '';
      mapState.focus = c.id; renderMapPart();
    };
    search.addEventListener('change', pickFrom);
    search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pickFrom(); } });
    var bars = function () {
      clear(typeBar); clear(layerBar); clear(viewBar); clear(scopeBar);
      Object.keys(Core.TYPE_NAMES).forEach(function (t) { typeBar.appendChild(chip(Core.TYPE_NAMES[t], mapState.types[t], function () { mapState.types[t] = !mapState.types[t]; renderMapPart(); }, 'k-' + family(t))); });
      data.layers.forEach(function (l) { layerBar.appendChild(chip(l.name, mapState.layers[l.id], function () { mapState.layers[l.id] = !mapState.layers[l.id]; renderMapPart(); })); });
      scopeBar.appendChild(chip('Most linked', mapState.scope === 'linked', function () { mapState.scope = 'linked'; renderMapPart(); }));
      scopeBar.appendChild(chip('All companies', mapState.scope === 'all', function () { mapState.scope = 'all'; renderMapPart(); }));
      ['map', 'list'].forEach(function (v) { viewBar.appendChild(chip(v === 'map' ? 'Map' : 'List', mapState.view === v, function () { mapState.view = v; renderMapPart(); })); });
      var co = mapState.focus ? Core.company(data, mapState.focus) : null;
      if (document.activeElement !== search) search.value = co ? co.name : '';
    };
    renderMapPart = function () {
      bars();
      var gs = groups();
      var deg = degrees(gs);
      var shown = shownSet(gs, deg);
      var nShown = Object.keys(shown).length;
      var visible = gs.filter(function (g) { return shown[g.from] && shown[g.to]; });
      clear(scopeNote);
      scopeNote.textContent = mapState.focus ? 'Showing ' + nameOf(mapState.focus) + ', every company a document links it to under these filters, and its supply chain as far as the documents go: ' + nShown + ' companies, ' + visible.length + (visible.length === 1 ? ' line.' : ' lines.')
        : mapState.scope === 'all' ? 'Showing every company in the layers that are on (' + nShown + '), with ' + visible.length + ' lines. Search a company to follow it.'
          : 'Showing the ' + nShown + ' companies with the most stated links under these filters (' + visible.length + ' lines). Choose “All companies”, or search one to follow it.';
      host.hidden = mapState.view !== 'map'; listHost.hidden = mapState.view !== 'list';
      if (mapState.view === 'map') drawMap(host, visible, shown, deg);
      else {
        clear(listHost);
        var rows = [].concat.apply([], (mapState.focus ? gs.filter(function (g) { return g.from === mapState.focus || g.to === mapState.focus; }) : visible).map(function (g) { return g.edges; }));
        listHost.appendChild(h('div', { cls: 'scroll card' }, h('table', { cls: 'etable' },
          h('caption', { cls: 'sr', text: 'Stated relationships' }),
          h('thead', null, h('tr', null, ['From', 'Relationship', 'To', 'Said by', 'Quote'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, rows.map(function (e) {
            return h('tr', null, h('th', { scope: 'row', text: nameOf(e.from) }), h('td', { text: Core.TYPE_NAMES[e.type] + (e.lookup ? ' (looked up)' : '') }), h('td', { text: nameOf(e.to) }), h('td', { text: nameOf(e.by) }),
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
          h('p', { cls: 'more' }, co.filer ? h('a', { cls: 'pill', href: co.lookup ? '#/x/' + co.cik : '#/c/' + co.id, text: co.name + '’s figures' }) : null, ' ', h('button', { type: 'button', cls: 'pill ghost', on: { click: function () { mapState.focus = null; renderMapPart(); } } }, 'Clear'))));
        if (direct.length) info.appendChild(edgeRows(direct));
      }
    };
    var page = h('div', { cls: 'page wide' },
      h('section', { cls: 'hero small' }, h('p', { cls: 'eyebrow', text: 'Stated relationships' }), h('h1', { text: 'The map' }),
        h('p', { cls: 'lede', text: 'Supply runs left to right on a wide screen and top to bottom on a phone: equipment, chips, components, devices, software, cloud, IT services. A line is drawn only where a company’s own document names the other. Tap a line for the quote; tap or search a company to follow the flow.' })),
      h('section', { cls: 'card pad controls' },
        h('div', { cls: 'ctl' }, h('label', { cls: 'ctl-l', for: 'flow', text: 'Follow the flow from' }), search, dl, miss),
        h('div', { cls: 'ctl' }, h('span', { cls: 'ctl-l', text: 'Show' }), typeBar),
        h('div', { cls: 'ctl' }, h('span', { cls: 'ctl-l', text: 'Layers' }), layerBar),
        h('div', { cls: 'ctl' }, h('span', { cls: 'ctl-l', text: 'Companies' }), scopeBar, viewBar)),
      h('section', { cls: 'card map-card' }, scopeNote, host, listHost,
        h('ul', { cls: 'legend pad' },
          h('li', null, s('svg', { width: 26, height: 10, 'aria-hidden': 'true' }, s('line', { cls: 'edge e-supply', x1: 1, x2: 25, y1: 5, y2: 5 })), 'Supply, sales, service or audit (arrow shows direction)'),
          h('li', null, s('svg', { width: 26, height: 10, 'aria-hidden': 'true' }, s('line', { cls: 'edge e-tie', x1: 1, x2: 25, y1: 5, y2: 5 })), 'Partner'),
          h('li', null, s('svg', { width: 26, height: 10, 'aria-hidden': 'true' }, s('line', { cls: 'edge e-rival', x1: 1, x2: 25, y1: 5, y2: 5 })), 'Competitor, as stated'),
          h('li', null, s('svg', { width: 14, height: 14, 'aria-hidden': 'true', cls: 'node' }, s('circle', { cx: 7, cy: 7, r: 6 })), 'A company in the set, sized by latest revenue'),
          h('li', null, s('svg', { width: 14, height: 14, 'aria-hidden': 'true', cls: 'node other' }, s('circle', { cx: 7, cy: 7, r: 5 })), 'Another company, shown only because a document names it'),
          data.lookups.length ? h('li', null, s('svg', { width: 14, height: 14, 'aria-hidden': 'true', cls: 'node looked' }, s('circle', { cx: 7, cy: 7, r: 5 })), 'Looked up on request - not in the reviewed set') : null),
        h('p', { cls: 'note pad', text: 'Circle sizes use US-dollar revenue; TSMC’s is its own dollar translation and ASML’s is its euro figure, unconverted. A missing line means no document in this set states the link - not that there is none.' })),
      info);
    page._after = renderMapPart;
    return page;
  }

  /* ---------------- routing ---------------- */

  function needs(parts) {
    if (parts[0] === 'patterns') return 'patterns';
    if (parts[0] === 'c' && parts[1]) {
      var c = Core.company(data, parts[1].toUpperCase());
      if (!c || !c.filer) return null;
      // A company's page reads two files: its annual figures, and the rest.
      return !ready['c/' + c.id] ? 'c/' + c.id : 'f/' + c.id;
    }
    return null;
  }
  /** The CIK a view needs looked up first: #/x/<cik>, or #/map/X<cik>. */
  function needsLookup(parts) {
    var cik = parts[0] === 'x' && /^\d{1,10}$/.test(parts[1] || '') ? Number(parts[1]) : parts[0] === 'map' && /^X\d{1,10}$/i.test(parts[1] || '') ? Number(parts[1].slice(1)) : null;
    if (!cik) return null;
    var c = Core.company(data, 'X' + cik);
    return c && c.filer ? null : cik;
  }
  function route() {
    if (!data) return;
    if (sheet.open) sheet.close();
    var hash = location.hash;
    var parts = hash.replace(/^#\/?/, '').split('/');
    var cik = needsLookup(parts);
    if (cik) {
      clear(main); main.appendChild(h('div', { cls: 'page' }, h('p', { cls: 'loading', role: 'status', text: 'Looking this company up on sec.gov… The first time takes a few seconds.' })));
      loadLookup(cik).then(function (p) {
        if (location.hash !== hash) return;
        if (p.inSet) location.replace('#/c/' + p.inSet); else route();
      }, function (e) {
        if (location.hash !== hash) return;
        clear(main);
        main.appendChild(h('div', { cls: 'page' }, h('p', { cls: 'crumb' }, h('a', { href: '#/', text: 'Companies' })), h('p', { cls: 'none card pad', role: 'alert', text: e.message + (e.status === 503 || e.status === 429 || e.status === 502 ? '' : ' Nothing is shown for it.') }), h('p', { cls: 'more' }, h('button', { type: 'button', cls: 'pill', on: { click: route } }, 'Try again'))));
      });
      return;
    }
    var part = needs(parts);
    if (part && !ready[part]) {
      clear(main); main.appendChild(h('p', { cls: 'loading', text: 'Loading…' }));
      load(part).then(function () { if (location.hash === hash) route(); }, function () {
        if (location.hash !== hash) return;
        clear(main);
        main.appendChild(h('div', { cls: 'page' }, h('p', { cls: 'none', text: 'That part of the data could not be loaded.' }), h('p', null, h('button', { type: 'button', cls: 'pill', on: { click: route } }, 'Try again'))));
      });
      return;
    }
    var page; var tab = 'home';
    if (parts[0] === 'c' && parts[1]) page = companyPage(parts[1].toUpperCase());
    else if (parts[0] === 'x' && parts[1]) page = companyPage('X' + Number(parts[1]));
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
    timer = setTimeout(function () { if (data && main.clientWidth !== lastWidth && !sheet.open && document.activeElement && document.activeElement.tagName !== 'INPUT') route(); }, 200);
  });

  load('index').then(function (d) {
    data = Core.start(d);
    data.lookups = [];
    document.getElementById('built').textContent = 'Dataset built ' + d.built + ' from ' + d.counts.sources + ' primary documents and ' + d.counts.filings + ' filings.';
    route();
  }).catch(function () {
    clear(main);
    main.appendChild(h('p', { cls: 'none', text: 'The dataset could not be loaded. Reload to try again.' }));
  });
}());
