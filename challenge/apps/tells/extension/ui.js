/* Tells extension - draws a result into a container. Used by the in-page
 * panel (inside a closed Shadow DOM) and by the toolbar popup.
 *
 * Every string - the post's text, a model's reasons, a source's title - goes
 * in through textContent or a created attribute, never innerHTML. The only
 * links drawn are https ones.
 */
(function (root) {
  'use strict';
  if (root.TellsUI) return;
  var Core = root.TellsCore;

  var CSS = [
    ':host{all:initial}',
    '.t{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#15171c;background:#fbfaf7;color-scheme:light}',
    '.t *{box-sizing:border-box}',
    '.t h2{font-size:15px;margin:0 0 6px}',
    '.t p{margin:6px 0}',
    '.t .muted{color:#4b505a}',
    '.t .small{font-size:12.5px}',
    '.t .meter{display:flex;align-items:baseline;gap:8px;margin:4px 0 2px}',
    '.t .score{font-size:30px;font-weight:750;letter-spacing:-.02em}',
    '.t .bar{position:relative;height:10px;border-radius:6px;background:#e7e4dc;margin:6px 0 4px;overflow:hidden}',
    '.t .band{position:absolute;top:0;bottom:0;background:#c9a6f5}',
    '.t .dot{position:absolute;top:-2px;width:4px;height:14px;background:#3b1d6e;border-radius:2px}',
    '.t .chip{display:inline-block;border:1px solid #cfcac0;border-radius:99px;padding:1px 8px;font-size:12px;color:#3d414a;background:#fff}',
    '.t .limits{border-left:3px solid #7a4bc2;padding:4px 8px;background:#f1ecfb;color:#2c2350;font-size:12.5px;margin:8px 0}',
    '.t .text{white-space:pre-wrap;word-wrap:break-word;background:#fff;border:1px solid #e3dfd5;border-radius:10px;padding:10px;max-height:260px;overflow:auto;font-size:13.5px}',
    '.t mark{background:transparent;color:inherit;cursor:pointer;border-radius:2px;text-decoration-thickness:2px;text-underline-offset:3px}',
    '.t mark.s-low{background:#fbf1c7;text-decoration:underline dotted #8a6d00}',
    '.t mark.s-medium{background:#fbdcc4;text-decoration:underline dashed #9a4300}',
    '.t mark.s-high{background:#f7c9d3;text-decoration:underline solid #9b1638}',
    '.t mark:focus{outline:2px solid #3b1d6e;outline-offset:1px}',
    '.t .why{background:#fff;border:1px solid #d6d0e8;border-radius:10px;padding:8px 10px;margin:8px 0;font-size:13px}',
    '.t ul{margin:4px 0;padding-left:18px}',
    '.t li{margin:3px 0}',
    '.t .grp{margin:10px 0 4px;font-weight:650;font-size:13px}',
    '.t button{font:inherit;font-weight:600;border-radius:10px;border:1px solid #3b1d6e;background:#3b1d6e;color:#fff;padding:7px 12px;cursor:pointer;margin:4px 6px 4px 0}',
    '.t button.ghost{background:#fff;color:#3b1d6e}',
    '.t button:disabled{opacity:.6;cursor:default}',
    '.t a{color:#4a1f9e}',
    '.t .err{color:#9b1638;font-weight:600}',
    '.t .src{border-top:1px solid #e3dfd5;padding:6px 0}',
  ].join('\n');

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'cls') n.className = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function https(url) { return /^https:\/\//i.test(String(url || '')); }

  function meter(c) {
    if (!c) return null;
    var bar = el('div', { cls: 'bar', role: 'img', 'aria-label': 'Reads as AI ' + c.score + ' out of 100, likely range ' + c.lo + ' to ' + c.hi });
    var band = el('div', { cls: 'band' }); band.style.left = c.lo + '%'; band.style.width = Math.max(2, c.hi - c.lo) + '%';
    var dot = el('div', { cls: 'dot' }); dot.style.left = 'calc(' + c.score + '% - 2px)';
    bar.appendChild(band); bar.appendChild(dot);
    return el('div', {}, [
      el('div', { cls: 'small muted', text: 'Reads as AI' }),
      el('div', { cls: 'meter' }, [el('span', { cls: 'score', text: String(c.score) }), el('span', { cls: 'muted', text: '/ 100 · ' + Core.levelWord(c.score) })]),
      bar,
      el('span', { cls: 'chip', text: c.confidence + ' confidence · likely ' + c.lo + '–' + c.hi }),
    ]);
  }

  function highlighted(text, spans, whyBox) {
    var box = el('div', { cls: 'text' });
    var byId = {};
    spans.forEach(function (s) { byId[s.id] = s; });
    Core.segments(text, spans).forEach(function (seg) {
      if (!seg.ids.length) { box.appendChild(document.createTextNode(seg.text)); return; }
      var hits = seg.ids.map(function (id) { return byId[id]; });
      var strength = Core.strongest(hits.map(function (h) { return h.strength; })) || 'low';
      var label = hits.map(function (h) { return h.label + ': ' + h.reason; }).join(' ');
      var m = el('mark', { cls: 's-' + strength, tabindex: '0', role: 'button', 'aria-label': strength + ' signal. ' + label, text: seg.text });
      var show = function () {
        whyBox.textContent = '';
        hits.forEach(function (h) { whyBox.appendChild(el('p', {}, [el('b', { text: h.label + ' (' + h.strength + '): ' }), h.reason])); });
        whyBox.hidden = false;
      };
      m.addEventListener('click', show);
      m.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } });
      box.appendChild(m);
    });
    return box;
  }

  /**
   * state: {text, quick, deep, originality, meta, visual, images, error,
   *         busy: {deep, originality, visual}, hasKey, actions: {deep, originality, visual, image, options}}
   */
  function render(container, state) {
    container.textContent = '';
    var t = el('div', { cls: 't' });
    container.appendChild(t);
    var c = Core.combine({ quick: state.quick, deep: state.deep, meta: state.meta, visual: state.visual });
    if (c) t.appendChild(meter(c));
    t.appendChild(el('div', { cls: 'limits', text: Core.LIMITS_LINE }));
    if (state.error) t.appendChild(el('p', { cls: 'err', role: 'alert', text: state.error }));
    if (state.note) t.appendChild(el('p', { cls: 'muted', role: 'status', text: state.note }));

    if (state.text) {
      var spans = (state.deep ? state.deep.spans : (state.quick ? state.quick.hits : [])) || [];
      var why = el('div', { cls: 'why', role: 'status' }); why.hidden = true;
      t.appendChild(el('div', { cls: 'grp', text: spans.length ? 'Tap a highlight for its reason' : 'No passages flagged' }));
      t.appendChild(highlighted(state.text, spans, why));
      t.appendChild(why);
      if (state.quick && state.quick.tooShort) t.appendChild(el('p', { cls: 'small muted', text: 'Short texts give very little to go on.' }));
    }

    if (state.deep) {
      t.appendChild(el('div', { cls: 'grp', text: 'Deep read' }));
      t.appendChild(el('p', { text: state.deep.summary }));
      if (state.deep.humanSigns && state.deep.humanSigns.length) t.appendChild(el('p', { cls: 'small muted', text: 'Human signs: ' + state.deep.humanSigns.join(' · ') }));
    } else if (state.quick) {
      t.appendChild(el('div', { cls: 'grp', text: 'Quick scan (free, low confidence)' }));
      var ul = el('ul');
      var seen = {};
      state.quick.hits.forEach(function (h) { if (!seen[h.rule]) { seen[h.rule] = 1; ul.appendChild(el('li', { text: h.label + ' – ' + h.reason })); } });
      (state.quick.signals || []).forEach(function (s) { ul.appendChild(el('li', { text: s.label + ' – ' + s.reason })); });
      if (!ul.childNodes.length) ul.appendChild(el('li', { text: 'None of the usual tells.' }));
      t.appendChild(ul);
    }

    if (state.meta) {
      t.appendChild(el('div', { cls: 'grp', text: 'Metadata' + (state.meta.points === 'ai' ? ' (a strong signal)' : '') }));
      var mu = el('ul');
      state.meta.findings.forEach(function (f) { mu.appendChild(el('li', {}, [el('b', { text: f.label }), f.detail ? ' — ' + f.detail : ''])); });
      t.appendChild(mu);
      if (state.meta.c2pa) t.appendChild(el('p', { cls: 'small' }, ['Content Credentials are read, not verified here. ', el('a', { href: 'https://contentcredentials.org/verify', target: '_blank', rel: 'noopener noreferrer', text: 'Verify at contentcredentials.org' })]));
    }
    if (state.visual) {
      t.appendChild(el('div', { cls: 'grp', text: 'Visual read (a weak signal)' }));
      t.appendChild(el('p', { text: state.visual.likelihood + '/100, ' + state.visual.confidence + ' confidence. ' + state.visual.summary }));
      var vu = el('ul');
      state.visual.artefacts.forEach(function (a) { vu.appendChild(el('li', { text: (a.frame != null ? 'Frame ' + (a.frame + 1) + ', ' : '') + a.where + ': ' + a.what })); });
      if (vu.childNodes.length) t.appendChild(vu);
      t.appendChild(el('p', { cls: 'small muted', text: Core.VISUAL_NOTE }));
    }

    if (state.originality) {
      var o = state.originality;
      t.appendChild(el('div', { cls: 'grp', text: 'Originality ' + o.score + '/100 (' + o.confidence + ' confidence)' }));
      t.appendChild(el('p', { text: o.summary }));
      if (!o.sources.length) t.appendChild(el('p', { cls: 'muted', text: Core.ORIGINAL_NONE }));
      o.sources.forEach(function (s) {
        t.appendChild(el('div', { cls: 'src' }, [
          https(s.url) ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title }) : el('span', { text: s.title }),
          el('div', { cls: 'small muted', text: s.host + (s.date ? ' · ' + s.date : '') + ' · overlap: ' + s.overlap }),
          el('div', { cls: 'small', text: s.note }),
        ]));
      });
      if (o.adds) t.appendChild(el('p', { cls: 'small' }, [el('b', { text: 'What it adds: ' }), o.adds]));
    }

    var a = state.actions || {};
    var row = el('div');
    if (state.text && a.deep && !state.deep) row.appendChild(el('button', { text: state.busy && state.busy.deep ? 'Reading…' : 'Deep read (uses credit)', on: { click: a.deep } }));
    if (state.text && a.originality && !state.originality) row.appendChild(el('button', { cls: 'ghost', text: state.busy && state.busy.originality ? 'Searching…' : 'Check originality (web search)', on: { click: a.originality } }));
    if (a.visual && !state.visual) row.appendChild(el('button', { text: state.busy && state.busy.visual ? 'Looking…' : 'Visual read (uses credit)', on: { click: a.visual } }));
    Array.prototype.forEach.call(row.querySelectorAll('button'), function (b) { if (/…$/.test(b.textContent)) b.disabled = true; });
    if (row.childNodes.length) t.appendChild(row);
    (state.images || []).forEach(function (src, i) {
      if (a.image && https(src)) t.appendChild(el('button', { cls: 'ghost', text: 'Check image ' + (i + 1) + ' in this post', on: { click: function () { a.image(src); } } }));
    });
    if (!state.hasKey && a.options) {
      t.appendChild(el('p', { cls: 'small muted' }, ['The quick scan is free and runs here. For a deep read, originality or a visual read, ', el('a', { href: '#', text: 'add your Tells device key', on: { click: function (e) { e.preventDefault(); a.options(); } } }), '.']));
    }
  }

  root.TellsUI = { render: render, CSS: CSS, el: el };
}(typeof self !== 'undefined' ? self : this));
