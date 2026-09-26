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
    $('copyUrl').addEventListener('click', function () { copy(ENDPOINT, 'URL'); });

    function drawToken(info) {
      var line = $('tokenState');
      if (info && info.configured) {
        line.textContent = 'A token is set up (made ' + ago(info.createdAt) + (info.lastUsedAt ? ', last used ' + ago(info.lastUsedAt) : ', not used yet') + ').';
        $('genToken').textContent = 'Replace token';
        $('revokeToken').hidden = false;
      } else {
        line.textContent = 'No token yet. Generate one, then copy it into the Shortcut.';
        $('genToken').textContent = 'Generate token';
        $('revokeToken').hidden = true;
      }
    }
    function loadToken() {
      return api('GET', '/api/inbox/token').then(drawToken).catch(function () { /* signed out is drawn by load() */ });
    }
    $('genToken').addEventListener('click', function () {
      var replacing = $('genToken').textContent.indexOf('Replace') === 0;
      if (replacing && !window.confirm('Make a new token? The old one stops working at once - update the Shortcut with the new one.')) return;
      api('POST', '/api/inbox/token').then(function (data) {
        var header = 'Bearer ' + data.token;
        $('tokenValue').textContent = header;
        $('tokenBox').hidden = false;
        $('copyHeader').onclick = function () { copy(header, 'Header value'); };
        toast('Token made - copy it now');
        return loadToken();
      }).catch(function (err) { toast(err.message); });
    });
    $('revokeToken').addEventListener('click', function () {
      if (!window.confirm('Turn the token off? The Shortcut stops working until you make a new one.')) return;
      api('DELETE', '/api/inbox/token').then(function () {
        $('tokenBox').hidden = true;
        $('tokenValue').textContent = '';
        toast('Token turned off');
        return loadToken();
      }).catch(function (err) { toast(err.message); });
    });

    // Coming back to the tab is the only refresh. No timer: this is one
    // person's inbox, and every poll would be a billed request.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') load();
    });

    drawFilters();
    load();
    loadToken();
  }

  return { esc: esc, ago: ago, itemHtml: itemHtml, filtersHtml: filtersHtml, emptyText: emptyText, KINDS: KINDS, STATUSES: STATUSES, ENDPOINT: ENDPOINT, boot: boot };
});
