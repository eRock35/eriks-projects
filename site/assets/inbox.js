/* The ideas inbox page (/admin/inbox).
 *
 * One file for two readers: the page loads it as a script, and test/inbox.js
 * requires it, so the HTML the test checks for escaping is the HTML the page
 * draws. It is a file rather than an inline <script> so the page can run
 * under a CSP with no inline script at all.
 *
 * Every string that came from the store - the text, Claude's note, tags, ids
 * - goes through esc() before it touches innerHTML. The text of an item is
 * whatever a Shortcut sent, so treat it as hostile.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InboxView = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') api.boot();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = ['idea', 'app idea', 'feature', 'bug', 'note'];
  var STATUSES = ['new', 'seen', 'doing', 'done', 'parked'];
  var STATUS_LABEL = { new: 'New', seen: 'Seen', doing: 'Doing', done: 'Done', parked: 'Parked' };
  var KIND_LABEL = { idea: 'Idea', 'app idea': 'App idea', feature: 'Feature', bug: 'Bug', note: 'Note' };
  var FILTERS = ['new', 'seen', 'doing', 'done', 'parked', 'all'];
  var FILTER_LABEL = { new: 'New', seen: 'Seen', doing: 'Doing', done: 'Done', parked: 'Parked', all: 'All' };
  var ENDPOINT = 'https://strongtechnicalconsulting.com/api/inbox';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ago(iso, now) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    var m = Math.max(0, ((now || Date.now()) - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return Math.round(m) + 'm ago';
    if (m < 48 * 60) return Math.round(m / 60) + 'h ago';
    if (m < 60 * 24 * 60) return Math.round(m / 1440) + 'd ago';
    return new Date(t).toISOString().slice(0, 10);
  }

  function options(list, labels, current) {
    return list.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(labels[v] || v) + '</option>';
    }).join('');
  }

  var TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  /** One item as HTML. Pure: the test renders hostile items through it. */
  function itemHtml(item, now) {
    var status = STATUSES.indexOf(item.status) >= 0 ? item.status : 'new';
    var kind = KINDS.indexOf(item.kind) >= 0 ? item.kind : 'idea';
    var tags = (item.tags || []).map(function (t) { return '<span class="tag">#' + esc(t) + '</span>'; }).join('');
    var when = ago(item.createdAt, now);
    return '<article class="item" data-id="' + esc(item.id) + '">'
      + '<p class="text">' + esc(item.text) + '</p>'
      + (item.claudeNote ? '<div class="note"><span class="note-by">Claude</span><p>' + esc(item.claudeNote) + '</p></div>' : '')
      + (tags ? '<div class="tags">' + tags + '</div>' : '')
      + '<div class="row">'
      + '<select class="pill st st-' + esc(status) + '" data-field="status" aria-label="Status">' + options(STATUSES, STATUS_LABEL, status) + '</select>'
      + '<select class="pill kd" data-field="kind" aria-label="Kind">' + options(KINDS, KIND_LABEL, kind) + '</select>'
      + '<span class="meta">' + (item.source === 'siri' ? 'Siri' : 'Page') + (when ? ' &middot; <time datetime="' + esc(item.createdAt) + '">' + esc(when) + '</time>' : '') + '</span>'
      + '<button type="button" class="del" data-act="delete" aria-label="Delete this item">' + TRASH + '</button>'
      + '</div>'
      + '</article>';
  }

  function filtersHtml(counts, current) {
    counts = counts || {};
    return FILTERS.map(function (f) {
      var n = typeof counts[f] === 'number' ? counts[f] : null;
      return '<button type="button" class="filter" data-filter="' + f + '" aria-pressed="' + (f === current) + '">'
        + esc(FILTER_LABEL[f]) + (n !== null ? ' <span class="count">' + n + '</span>' : '') + '</button>';
    }).join('');
  }

  function emptyText(filter) {
    if (filter === 'new') return 'Nothing new. Say “Hey Siri, Idea” or type one above.';
    if (filter === 'all') return 'The inbox is empty. Your first idea goes in the box above.';
    return 'Nothing marked ' + (FILTER_LABEL[filter] || filter).toLowerCase() + '.';
  }

  /* ---------------- asks (the concierge) ---------------- */

  var ASK_LABEL = { new: 'New', doing: 'Working', parked: 'Needs you', answered: 'Answered', done: 'Done', expired: 'Expired', cancelled: 'Cancelled' };
  var ASK_CLASS = { new: 'new', doing: 'doing', parked: 'need', answered: 'seen', done: 'done', expired: 'parked', cancelled: 'parked' };
  var TYPE_LABEL = { text: 'Message', url: 'Link', image: 'Screenshot' };
  var SOURCE_LABEL = { share: 'Share sheet', screen: 'Action button', siri: 'Siri', page: 'Page' };
  var OPEN = ['new', 'doing', 'parked', 'answered'];

  /** Only an https link is drawn as a link; anything else is text. */
  function safeHref(url) {
    return /^https:\/\/[^\s"'<>]+$/i.test(String(url || '')) ? String(url) : null;
  }

  function contextHtml(ctx) {
    if (!ctx) return '';
    var bits = [esc(TYPE_LABEL[ctx.type] || 'Capture')];
    if (ctx.app && String(ctx.app).toLowerCase().indexOf(String(TYPE_LABEL[ctx.type] || '').toLowerCase()) !== 0) bits.push(esc(ctx.app));
    if (ctx.image) bits.push(esc(ctx.image.width + '\u00d7' + ctx.image.height + ', ' + Math.round((ctx.image.bytes || 0) / 1024) + ' KB'));
    var title = ctx.title ? '<span class="ctx-title">' + esc(ctx.title) + '</span>' : '';
    var href = safeHref(ctx.url);
    var link = ctx.url ? (href
      ? '<a class="ctx-url" href="' + esc(href) + '" rel="noopener noreferrer nofollow" target="_blank">' + esc(href.replace(/^https:\/\//, '')) + '</a>'
      : '<span class="ctx-url">' + esc(ctx.url) + '</span>') : '';
    var gone = (ctx.type === 'text' && !ctx.hasText) || (ctx.type === 'image' && !ctx.image) ? ' <span class="ctx-gone">(read and deleted)</span>' : '';
    return '<p class="ctx">' + bits.join(' &middot; ') + gone + (title ? '<br>' + title : '') + (link ? '<br>' + link : '') + '</p>';
  }

  /** One ask as HTML. Pure: the test renders hostile asks through it. */
  function askHtml(item, now) {
    var status = ASK_LABEL[item.status] ? item.status : 'new';
    var ask = item.ask || {};
    var when = ago(item.updatedAt || item.createdAt, now);
    var choices = (ask.choices || []).slice(0, 3);
    var question = '';
    if (status === 'parked' && ask.question) {
      question = '<div class="question"><p class="q">' + esc(ask.question) + '</p><div class="choices">'
        + choices.map(function (c) {
          var adds = ask.addChoice && c === ask.addChoice;
          return '<button type="button" class="btn' + (adds ? '' : ' ghost') + '" data-act="reply" data-k="' + esc(ask.k) + '" data-choice="' + esc(c) + '">' + esc(c) + '</button>';
        }).join('')
        + '</div>' + (ask.add ? '<p class="tip">Carries ' + (ask.add.type === 'event' ? 'a calendar event' : 'a reminder') + (ask.add.when ? ' for ' + esc(ask.add.when) : '') + ' - added only if you pick &ldquo;' + esc(ask.addChoice) + '&rdquo;.</p>' : '') + '</div>';
    } else if (item.answer && item.answer.choice) {
      question = '<p class="answered">' + (ask.question ? esc(ask.question) + ' &mdash; ' : '') + 'you chose <strong>' + esc(item.answer.choice) + '</strong></p>';
    }
    return '<article class="item ask" data-id="' + esc(item.id) + '">'
      + '<p class="text">' + (item.note ? esc(item.note) : '<span class="muted">No words - just the capture.</span>') + '</p>'
      + contextHtml(item.context)
      + (item.claudeNote ? '<div class="note"><span class="note-by">Concierge</span><p>' + esc(item.claudeNote) + '</p></div>' : '')
      + question
      + '<div class="add-slot" hidden></div>'
      + '<div class="row">'
      + '<span class="pill st st-' + esc(ASK_CLASS[status]) + ' flat">' + esc(ASK_LABEL[status]) + '</span>'
      + '<span class="meta">' + esc(SOURCE_LABEL[item.source] || 'Page') + (when ? ' &middot; ' + esc(when) : '') + '</span>'
      + (OPEN.indexOf(status) >= 0 ? '<button type="button" class="linkish" data-act="cancel">Cancel</button>' : '')
      + '<button type="button" class="del" data-act="delete" aria-label="Delete this ask">' + TRASH + '</button>'
      + '</div>'
      + '</article>';
  }

  function tokenHtml(t, now) {
    var used = t.lastUsedAt ? 'used ' + ago(t.lastUsedAt, now) : 'not used yet';
    return '<li class="tok" data-ref="' + esc(t.ref) + '">'
      + '<span class="pill st st-' + (t.scope === 'agent' ? 'seen' : 'new') + ' flat">' + (t.scope === 'agent' ? 'Agent' : 'Phone') + '</span>'
      + '<span class="tok-main"><strong>' + esc(t.label) + '</strong> <code>' + esc(String(t.prefix || '').slice(0, 6)) + '&hellip;</code>'
      + '<span class="tok-meta">' + (t.createdAt ? 'made ' + esc(ago(t.createdAt, now)) + ', ' : '') + esc(used) + '</span></span>'
      + '<button type="button" class="btn warn small" data-act="revoke">Revoke</button>'
      + '</li>';
  }

  function icsText(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
  }
  function icsTime(iso) {
    return new Date(Date.parse(iso)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /** An event as an .ics file, for an answer given on this page: Safari on
   *  the iPhone opens it in Calendar, where one tap adds it. Times in UTC. */
  function icsFor(add, now) {
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//strongtechnicalconsulting//concierge//EN', 'BEGIN:VEVENT',
      'UID:' + Math.random().toString(36).slice(2) + '@strongtechnicalconsulting.com',
      'DTSTAMP:' + icsTime((now || new Date()).toISOString()),
      'DTSTART:' + icsTime(add.start), 'DTEND:' + icsTime(add.end),
      'SUMMARY:' + icsText(add.title)];
    if (add.location) lines.push('LOCATION:' + icsText(add.location));
    if (add.notes) lines.push('DESCRIPTION:' + icsText(add.notes));
    if (safeHref(add.url)) lines.push('URL:' + add.url);
    if (typeof add.alertMinutes === 'number') lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(add.title), 'TRIGGER:-PT' + add.alertMinutes + 'M', 'END:VALARM');
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  function addHtml(add) {
    if (add.type === 'event') {
      return '<p class="q">' + esc(add.title) + '</p><p class="tip">' + esc(add.when) + (add.location ? ' &middot; ' + esc(add.location) : '') + '</p>'
        + '<button type="button" class="btn" data-act="ics">Add to Calendar</button>';
    }
    return '<p class="q">Reminder: ' + esc(add.title) + '</p><p class="tip">' + esc(add.when) + (add.notes ? ' &middot; ' + esc(add.notes) : '') + '</p>'
      + '<button type="button" class="btn ghost" data-act="copyrem">Copy it for Reminders</button>';
  }

  /* ---------------- the page ---------------- */

  function boot() {
    var $ = function (id) { return document.getElementById(id); };
    if (!$('inboxApp')) return;

    var state = { filter: 'new', items: [], counts: null, busy: false };
    try { var saved = localStorage.getItem('inbox-filter'); if (FILTERS.indexOf(saved) >= 0) state.filter = saved; } catch (e) { /* private mode */ }

    var toastTimer = null;
    function toast(msg) {
      var t = $('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
    }

    function signedOut() {
      $('list').innerHTML = '<p class="empty">You are signed out. <a href="/admin/login">Sign in</a> to see the inbox.</p>';
    }

    function api(method, url, body) {
      var opts = { method: method, headers: { 'X-Inbox-Page': '1' }, credentials: 'same-origin' };
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      return fetch(url, opts).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 401 || res.status === 404 && url.indexOf('/api/inbox/token') === 0) { signedOut(); }
          if (!res.ok) throw new Error(data.error || 'That did not work.');
          return data;
        });
      });
    }

    function drawFilters() {
      $('filters').innerHTML = filtersHtml(state.counts, state.filter);
    }

    function drawList() {
      var now = Date.now();
      $('list').innerHTML = state.items.length
        ? state.items.map(function (it) { return itemHtml(it, now); }).join('')
        : '<p class="empty">' + esc(emptyText(state.filter)) + '</p>';
    }

    function load() {
      return api('GET', '/api/inbox?status=' + encodeURIComponent(state.filter)).then(function (data) {
        state.items = data.items || [];
        state.counts = data.counts || null;
        drawFilters();
        drawList();
      }).catch(function (err) {
        if (!/sign/i.test($('list').textContent)) $('list').innerHTML = '<p class="empty err">' + esc(err.message) + '</p>';
      });
    }

    /* adding */
    var text = $('text');
    function save() {
      var value = text.value.trim();
      if (!value || state.busy) { text.focus(); return; }
      state.busy = true;
      $('save').disabled = true;
      var body = { text: value };
      if ($('kind').value) body.kind = $('kind').value;
      api('POST', '/api/inbox', body).then(function (data) {
        text.value = '';
        $('kind').value = '';
        toast(data.message || 'Saved');
        return load();
      }).catch(function (err) { toast(err.message); }).then(function () {
        state.busy = false;
        $('save').disabled = false;
        text.focus();
      });
    }
    $('save').addEventListener('click', save);
    text.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });

    /* filtering */
    $('filters').addEventListener('click', function (e) {
      var b = e.target.closest('[data-filter]');
      if (!b) return;
      state.filter = b.getAttribute('data-filter');
      try { localStorage.setItem('inbox-filter', state.filter); } catch (err) { /* fine */ }
      drawFilters();
      load();
    });

    /* editing */
    $('list').addEventListener('change', function (e) {
      var sel = e.target.closest('select[data-field]');
      if (!sel) return;
      var card = sel.closest('[data-id]');
      var patch = {};
      patch[sel.getAttribute('data-field')] = sel.value;
      sel.disabled = true;
      api('PATCH', '/api/inbox/' + encodeURIComponent(card.getAttribute('data-id')), patch).then(function (data) {
        toast(sel.getAttribute('data-field') === 'status' ? 'Marked ' + STATUS_LABEL[data.item.status].toLowerCase() : 'Filed as ' + KIND_LABEL[data.item.kind].toLowerCase());
        return load();
      }).catch(function (err) { toast(err.message); sel.disabled = false; });
    });
    $('list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act="delete"]');
      if (!b) return;
      var card = b.closest('[data-id]');
      var snippet = card.querySelector('.text').textContent.slice(0, 80);
      if (!window.confirm('Delete this?\n\n' + snippet)) return;
      api('DELETE', '/api/inbox/' + encodeURIComponent(card.getAttribute('data-id'))).then(function () {
        toast('Deleted');
        return load();
      }).catch(function (err) { toast(err.message); });
    });

    /* Siri */
    function copy(value, label) {
      var done = function () { toast(label + ' copied'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () { window.prompt('Copy this:', value); });
      } else {
        window.prompt('Copy this:', value);
      }
    }
    $('endpoint').textContent = ENDPOINT;

    $('captureUrl').textContent = ENDPOINT + '/capture';
    $('answersUrl').textContent = ENDPOINT + '/answers';
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-copy]');
      if (!b) return;
      var src = $(b.getAttribute('data-copy'));
      if (src) copy(src.textContent, b.getAttribute('data-what') || 'Text');
    });

    /* tokens: several, each for the phone or the agent */
    function loadTokens() {
      return api('GET', '/api/inbox/tokens').then(function (data) {
        var list = data.tokens || [];
        var now = Date.now();
        $('tokens').innerHTML = list.length
          ? list.map(function (t) { return tokenHtml(t, now); }).join('')
          : '<li class="empty">No tokens yet. Make a phone token for the Shortcuts.</li>';
      }).catch(function () { /* signed out is drawn by load() */ });
    }
    $('mintToken').addEventListener('click', function () {
      var scope = $('tokScope').value;
      var label = $('tokLabel').value.trim();
      api('POST', '/api/inbox/tokens', { scope: scope, label: label }).then(function (data) {
        var header = 'Bearer ' + data.token;
        $('tokenValue').textContent = header;
        $('tokenWhat').textContent = (data.scope === 'agent' ? 'Agent' : 'Phone') + ' token "' + data.label + '" - shown once. Copy it now.';
        $('tokenBox').hidden = false;
        $('copyHeader').onclick = function () { copy(header, 'Header value'); };
        $('tokLabel').value = '';
        toast('Token made - copy it now');
        return loadTokens();
      }).catch(function (err) { toast(err.message); });
    });
    $('tokens').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act="revoke"]');
      if (!b) return;
      var row = b.closest('[data-ref]');
      if (!window.confirm('Revoke this token? Whatever holds it stops working at once.')) return;
      api('DELETE', '/api/inbox/tokens/' + encodeURIComponent(row.getAttribute('data-ref'))).then(function () {
        toast('Token revoked');
        $('tokenBox').hidden = true;
        $('tokenValue').textContent = '';
        return loadTokens();
      }).catch(function (err) { toast(err.message); });
    });

    /* asks */
    var askState = { items: [], view: 'open', adds: {} };
    try { var v = localStorage.getItem('inbox-asks-view'); if (v === 'all' || v === 'open') askState.view = v; } catch (e) { /* fine */ }
    function drawAsks() {
      var now = Date.now();
      var shown = askState.items.filter(function (a) { return askState.view === 'all' || OPEN.indexOf(a.status) >= 0; });
      $('askFilters').innerHTML = ['open', 'all'].map(function (f) {
        var n = f === 'open' ? askState.items.filter(function (a) { return OPEN.indexOf(a.status) >= 0; }).length : askState.items.length;
        return '<button type="button" class="filter" data-askview="' + f + '" aria-pressed="' + (askState.view === f) + '">' + (f === 'open' ? 'Open' : 'All') + ' <span class="count">' + n + '</span></button>';
      }).join('');
      $('asks').innerHTML = shown.length
        ? shown.map(function (a) { return askHtml(a, now); }).join('')
        : '<p class="empty">' + (askState.view === 'open' ? 'Nothing open. Share something to &ldquo;Do this&rdquo;, or say &ldquo;Hey Siri, Errand&rdquo;.' : 'No asks yet.') + '</p>';
      Object.keys(askState.adds).forEach(function (id) {
        var card = $('asks').querySelector('[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] .add-slot');
        if (card) { card.innerHTML = addHtml(askState.adds[id]); card.hidden = false; }
      });
    }
    function loadAsks() {
      return api('GET', '/api/inbox?kind=ask&status=all&order=updated&limit=50').then(function (data) {
        askState.items = data.items || [];
        drawAsks();
      }).catch(function (err) {
        if (!/sign/i.test($('list').textContent)) $('asks').innerHTML = '<p class="empty err">' + esc(err.message) + '</p>';
      });
    }
    $('askFilters').addEventListener('click', function (e) {
      var b = e.target.closest('[data-askview]');
      if (!b) return;
      askState.view = b.getAttribute('data-askview');
      try { localStorage.setItem('inbox-asks-view', askState.view); } catch (err) { /* fine */ }
      drawAsks();
    });
    function download(name, type, text) {
      var url = URL.createObjectURL(new Blob([text], { type: type }));
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
    $('asks').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var card = b.closest('[data-id]');
      var id = card.getAttribute('data-id');
      var act = b.getAttribute('data-act');
      if (act === 'reply') {
        b.disabled = true;
        api('POST', '/api/inbox/' + encodeURIComponent(id) + '/reply', { k: b.getAttribute('data-k'), choice: b.getAttribute('data-choice') }).then(function (data) {
          if (data.add) askState.adds[id] = data.add;
          toast(data.message || 'Answered');
          return loadAsks();
        }).catch(function (err) { toast(err.message); b.disabled = false; loadAsks(); });
      } else if (act === 'ics') {
        var add = askState.adds[id];
        if (add) download('event.ics', 'text/calendar', icsFor(add, new Date()));
      } else if (act === 'copyrem') {
        var rem = askState.adds[id];
        if (rem) copy(rem.title + (rem.when ? ' - ' + rem.when : '') + (rem.notes ? '\n' + rem.notes : ''), 'Reminder');
      } else if (act === 'cancel') {
        if (!window.confirm('Cancel this ask? The concierge stops on it, and what it captured is deleted.')) return;
        api('PATCH', '/api/inbox/' + encodeURIComponent(id), { status: 'cancelled' }).then(function () {
          toast('Cancelled');
          return loadAsks();
        }).catch(function (err) { toast(err.message); });
      } else if (act === 'delete') {
        if (!window.confirm('Delete this ask, and anything it still holds?')) return;
        api('DELETE', '/api/inbox/' + encodeURIComponent(id)).then(function () {
          delete askState.adds[id];
          toast('Deleted');
          return loadAsks();
        }).catch(function (err) { toast(err.message); });
      }
    });

    // Coming back to the tab is the only refresh. No timer: this is one
    // person's inbox, and every poll would be a billed request.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { load(); loadAsks(); }
    });

    drawFilters();
    load();
    loadAsks();
    loadTokens();
  }

  return {
    esc: esc, ago: ago, itemHtml: itemHtml, filtersHtml: filtersHtml, emptyText: emptyText,
    askHtml: askHtml, tokenHtml: tokenHtml, icsFor: icsFor, safeHref: safeHref,
    KINDS: KINDS, STATUSES: STATUSES, ENDPOINT: ENDPOINT, boot: boot,
  };
});
