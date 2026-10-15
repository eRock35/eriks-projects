/* Zoned - the page. One file, no build step.
 *
 * SCANS ARE READ HERE AND NOWHERE ELSE, AND NOTHING IS SCANNED. Files the
 * user made (nmap output, an ARP table, a DHCP list) are read by ZonedCore in
 * this browser; the devices, roles, findings, plan, rules, letter and report
 * are worked out here; nothing about the network is sent. The one request
 * that describes devices is "Help me identify the unknowns", and it sends
 * ZonedCore.identifyPayload - vendor names, hostnames and open ports of the
 * devices the user ticked, with no IP or MAC address - shown in full first.
 *
 * Every string that came from a file (a hostname, a banner, a vendor name, a
 * page title) or from the server is escaped before it is drawn, and no
 * handler is written into markup: clicks are routed by data-act attributes
 * from one listener (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.ZonedCore;
  var D = window.ZonedDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_SAVED = 'zoned-saved-v1';
  var K_CMD = 'zoned-cmd-v1';
  var K_LETTER = 'zoned-letter-v1';
  var TABS = [['findings', '🚨', 'Findings', 'Findings'], ['devices', '📋', 'Devices', 'Devices'], ['plan', '🧱', 'Plan', 'Zone plan'], ['contractor', '🔧', 'Contractor', 'Contractor'], ['report', '📝', 'Report', 'Report']];
  var esc = C.esc;
  var plural = C.plural;
  var ROLES = C.ROLES;
  var SEV = C.SEVERITY;

  var state = {
    me: null,
    view: 'start',       // start | load | dash
    tab: 'findings',
    files: [],           // the user's own files: {name, text, mapping, parsed} - this tab only
    demo: false,
    a: null,             // ZonedCore.analyse(...) - in memory only
    hash: '',
    saved: { roles: {}, notes: {}, checks: {}, letter: null },
    filter: 'all',
    q: '',
    gear: 'generic',
    cmd: { cidr: '192.168.1.0/24', os: 'unix', which: 'full' },
    letterFields: { business: '', you: '', contractor: '', when: '' },
    suggestions: {},     // device id -> the AI's suggestion (this tab only)
    showPaste: false,
    openFind: { 0: true },
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.error) {
          var e = new Error(data.error || 'Something went wrong.');
          e.status = res.status; e.data = data;
          throw e;
        }
        return data;
      });
    });
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  var toastTimer = null;
  function toast(msg, ms) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function sevPill(s, word) { return '<span class="pill s-' + s + '"><span aria-hidden="true">' + SEV[s].icon + '</span>' + esc(word || SEV[s].word) + '</span>'; }
  function rolePill(role) { return '<span class="role' + (ROLES[role].ot ? ' ot' : '') + '"><span aria-hidden="true">' + ROLES[role].icon + '</span>' + esc(ROLES[role].label) + '</span>'; }
  function devChip(d) { return '<button class="devchip" type="button" data-act="device" data-id="' + esc(d.id) + '"><span aria-hidden="true">' + ROLES[d.cls.role].icon + '</span><span class="nm">' + esc(d.name) + '</span>' + (d.ip ? '<span class="ip">' + esc(d.ip) + '</span>' : '') + '</button>'; }
  function actHtml(a) { var deny = /^Deny/.test(a); return '<span class="act ' + (deny ? 'deny' : 'allow') + '"><span aria-hidden="true">' + (deny ? '✕' : '✓') + '</span>' + esc(a) + '</span>'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else here stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('Identifying devices with AI uses about a cent of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- saved on this device: overrides, notes, ticks ---------------- */

  function blankSaved() { return { roles: {}, notes: {}, checks: {}, letter: null }; }
  function loadSaved() {
    state.saved = blankSaved();
    if (state.demo) return;
    var all = recall(K_SAVED);
    var mine = all && all.sets && all.sets[state.hash];
    if (!mine || typeof mine !== 'object') return;
    ['roles', 'notes', 'checks'].forEach(function (k) {
      if (mine[k] && typeof mine[k] === 'object') Object.keys(mine[k]).forEach(function (id) {
        var v = mine[k][id];
        if (k === 'roles' && ROLES[v]) state.saved.roles[id] = v;
        else if (k === 'notes' && typeof v === 'string') state.saved.notes[id] = v.slice(0, C.LIMITS.noteLen);
        else if (k === 'checks' && v === 1) state.saved.checks[id] = 1;
      });
    });
    if (typeof mine.letter === 'string') state.saved.letter = mine.letter.slice(0, 20000);
  }
  function saveSaved() {
    if (state.demo || !state.hash) return;
    var all = recall(K_SAVED);
    if (!all || typeof all !== 'object' || !all.sets || typeof all.sets !== 'object') all = { v: 1, sets: {} };
    var s = state.saved;
    var empty = !Object.keys(s.roles).length && !Object.keys(s.notes).length && !Object.keys(s.checks).length && s.letter == null;
    if (empty) delete all.sets[state.hash];
    else all.sets[state.hash] = { at: Date.now(), roles: s.roles, notes: s.notes, checks: s.checks, letter: s.letter };
    var keys = Object.keys(all.sets).sort(function (x, y) { return (all.sets[y].at || 0) - (all.sets[x].at || 0); });
    keys.slice(20).forEach(function (k) { delete all.sets[k]; });
    keep(K_SAVED, all);
  }
  function savedCount() { var s = state.saved; return Object.keys(s.roles).length + Object.keys(s.notes).filter(function (k) { return s.notes[k]; }).length + Object.keys(s.checks).length + (s.letter != null ? 1 : 0); }

  /* ---------------- the analysis ---------------- */

  function inputsNow() { return state.demo ? D.files().map(function (f) { return C.readInput(f.text, f.name); }) : state.files.map(function (f) { return f.parsed; }); }
  function analyseNow() {
    var inputs = inputsNow();
    state.a = C.analyse(inputs, { overrides: state.saved.roles });
  }
  function openWith(demo) {
    state.demo = demo;
    var inputs = inputsNow();
    state.hash = C.hashText(inputs.map(function (i) { return i.hash; }).sort().join('|'));
    loadSaved();
    state.suggestions = {};
    state.filter = 'all'; state.q = ''; state.openFind = { 0: true };
    if (demo) state.letterFields = Object.assign({}, D.letterFields);
    else { var lf = recall(K_LETTER); state.letterFields = { business: '', you: '', contractor: '', when: '' }; if (lf && typeof lf === 'object') Object.keys(state.letterFields).forEach(function (k) { if (typeof lf[k] === 'string') state.letterFields[k] = lf[k].slice(0, 80); }); }
    analyseNow();
  }

  /* ---------------- routing ---------------- */

  function isTab(h) { return TABS.some(function (t) { return t[0] === h; }); }
  function go(where) {
    if (isTab(where)) { state.view = 'dash'; state.tab = where; }
    else if (where === 'check') state.view = 'load';
    else state.view = 'start';
    history.pushState(null, '', BASE + '#' + where);
    draw(); scrollTo(0, 0);
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'example') return openDemo(true);
    if (h === 'check') { state.view = 'load'; draw(); return scrollTo(0, 0); }
    if (isTab(h)) {
      if (!state.a) return openDemo(true, h);
      state.view = 'dash'; state.tab = h; return draw();
    }
    state.view = 'start'; draw(); scrollTo(0, 0);
  }
  window.addEventListener('popstate', route);
  function openDemo(replace, tab) {
    openWith(true);
    state.view = 'dash'; state.tab = tab || 'findings';
    if (replace) history.replaceState(null, '', BASE + '#' + state.tab); else history.pushState(null, '', BASE + '#' + state.tab);
    draw(); scrollTo(0, 0);
  }

  function draw() {
    closeSheet(true);
    var main = $('#main');
    document.body.classList.toggle('has-tabs', state.view === 'dash');
    if (state.view === 'load') { main.innerHTML = loadHtml(); wireLoad(); return; }
    if (state.view !== 'dash' || !state.a) { main.innerHTML = startHtml(); return; }
    var a = state.a;
    var badges = { findings: a.findings.filter(function (f) { return f.severity === 'high'; }).length, devices: a.stats.byRole.unknown };
    var html = stripHtml();
    html += '<nav class="tabbar dk-tabbar" aria-label="Zoned"><div class="tabbar-inner"><a class="rail-brand" href="./#start" data-act="home"><span aria-hidden="true">🚧</span>Zoned</a>' + TABS.map(function (t) {
      var n = badges[t[0]];
      var label = t[0] === 'findings' ? n + ' high risk' : n + ' not identified';
      return '<a class="tab' + (t[0] === state.tab ? ' on' : '') + '" href="#' + t[0] + '" data-act="tab" data-tab="' + t[0] + '"' + (t[0] === state.tab ? ' aria-current="page"' : '') + '><span class="i" aria-hidden="true">' + t[1] + '</span><span class="short">' + t[2] + '</span><span class="long">' + t[3] + '</span>' + (n ? '<span class="tab-badge" aria-label="' + esc(label) + '">' + n + '</span>' : '') + '</a>';
    }).join('') + '</div></nav>';
    html += '<div id="tab"></div>' + footer();
    main.innerHTML = html;
    drawTab();
  }
  function drawTab() {
    var el = $('#tab');
    if (!el) return;
    if (state.tab === 'devices') { el.innerHTML = devicesHtml(); wireDevices(); }
    else if (state.tab === 'plan') el.innerHTML = planHtml();
    else if (state.tab === 'contractor') { el.innerHTML = contractorHtml(); wireContractor(); }
    else if (state.tab === 'report') el.innerHTML = reportHtml();
    else el.innerHTML = findingsHtml();
  }
  function footer() {
    return '<footer class="foot"><p>🔒 Zoned reads scans you already ran, on this device. It never scans, pings or connects to anything, and nothing is uploaded.</p><p>Run scans only on networks you are responsible for. Roles are worked out from clues - check a device before you move it.</p></footer>';
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var viz = ['💳', '❄️', '🖥️', '📹', '📱', '🌡️', '💳', '📡', '🖨️', '📹', '📱', '💡', '💳', '📹', '❄️'];
    var hot = { '❄️': 1, '🌡️': 1, '📡': 1, '💡': 1 };
    var html = '<section class="hero"><div class="flatviz" aria-hidden="true"><div class="box">' + viz.map(function (e) { return '<span' + (hot[e] ? ' class="hot"' : '') + '>' + e + '</span>'; }).join('') + '</div><p class="cap">Today: one flat network. The fridge controller can reach the till.</p></div>' +
      '<p class="readsline"><span aria-hidden="true">🔒</span>Reads a scan you already ran. Zoned never scans anything and nothing is uploaded.</p>' +
      '<div class="kicker"><span aria-hidden="true">🚧</span>For store and office IT</div>' +
      '<h1>Find the building and fridge controllers on your till network - and fence them off.</h1>' +
      '<p>The refrigeration or HVAC contractor plugged their controllers - and often a cellular modem - into the same network as your tills, office PCs and guest Wi-Fi. Zoned finds them in a scan you already have, shows what can reach what, and hands you the zones, the firewall rules and a letter for the contractor.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="example">See an example store</button><button class="btn big ghost" type="button" data-act="gocheck">Check my network</button></div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">👤</span><span><b>No account needed.</b> Everything except one optional AI helper is free and works in this browser.</span></div></section>';
    html += '<div class="how">' +
      '<section class="card"><span class="n" aria-hidden="true">1</span><h2>Bring a scan</h2><p>An nmap scan, the router’s DHCP list or an ARP table. We give you the exact command. It stays on this device.</p></section>' +
      '<section class="card"><span class="n" aria-hidden="true">2</span><h2>See what is really there</h2><p>Every device sorted into tills, office, cameras, guests - and the building and refrigeration controllers - with why we think so.</p></section>' +
      '<section class="card"><span class="n" aria-hidden="true">3</span><h2>Fence it off</h2><p>Zones and VLANs with every device placed, default-deny firewall rules, steps for your gear and a letter for the contractor.</p></section></div>';
    html += '<div class="grid2" style="margin-top:14px">' +
      '<section class="card"><h2>What it recognises</h2><p class="small muted">From the maker names your scan already shows, the ports that answer and the names devices give themselves.</p><ul class="chips">' +
      ['❄️ Danfoss, Emerson, Carel, Dixell', '🌡️ Johnson Controls, Honeywell, Siemens, Tridium', '💡 Lutron, Acuity', '📡 Sierra Wireless, Cradlepoint, Teltonika', '🏭 BACnet, Modbus, Niagara Fox', '💳 Verifone, Ingenico, PAX, NCR', '📹 Hikvision, Dahua, Axis', '📱 Phones on guest Wi-Fi'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' +
      '<section class="card"><h2>What you get</h2><ul class="chips">' +
      ['🚨 Findings ranked, in plain words', '🧱 Six zones, every device placed', '🔥 Firewall rules, default deny', '🔧 Steps for UniFi, Meraki, pfSense, FortiGate', '✉️ A letter for the contractor', '📝 A report to print or send'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section></div>';
    html += '<section class="card"><h2>Why it matters</h2><p class="muted lede">A refrigeration rack controller or rooftop HVAC controller runs old software, often keeps its factory password, and is looked after by someone outside your business - sometimes through a cellular modem your firewall never sees. On a flat network, getting into one means reaching the tills. Card-payment rules (PCI DSS) also tend to count everything on a flat network as in scope. Separating them is not hard; knowing what is there is the first step.</p>' +
      '<div class="btns"><button class="btn" type="button" data-act="example">See the example</button><button class="btn ghost" type="button" data-act="gocheck">Check my network</button></div></section>' + footer();
    return html;
  }

  /* ---------------- check my network ---------------- */

  var CMD_KINDS = [['full', 'Full scan (best)'], ['quick', 'Quick list'], ['udp', 'Building ports (UDP)'], ['arp', 'ARP table'], ['dhcp', 'DHCP list']];
  function cmdExplain(which, c) {
    var win = state.cmd.os === 'windows';
    if (which === 'full') return ['<code>-sV</code> asks each open port what it is - product and version. That is how building controllers give themselves away.', '<code>-O</code> guesses the operating system.', '<code>--max-rate 200</code> keeps it gentle: at most 200 probes a second, because old controllers can misbehave under heavy scanning.', '<code>-p T:…</code> the usual ports plus building ones (BACnet 47808, Niagara 1911/4911, Modbus 502, MQTT) and remote-access ones (RDP, VNC, TeamViewer).', '<code>-oX ' + esc(c.full.file) + '</code> saves it as XML for Zoned. Takes 10-30 minutes for a /24.'];
    if (which === 'quick') return ['<code>-sn</code> does not touch any ports: it only lists who answers, with each device’s MAC address and maker (run it from a computer on the store network).', 'A minute or two. Fewer clues, so more devices will be "not identified" - add the full scan later.'];
    if (which === 'udp') return ['<code>-sU</code> scans UDP, where BACnet/IP (47808), LonWorks (1628-1629) and KNX (3671) live.', 'UDP is slow, so this asks only those four ports. Drop its file in alongside the full scan - Zoned merges them by MAC address.'];
    if (which === 'arp') return ['No scanning at all: the computer’s own list of devices it talked to recently.' + (win ? '' : ' On Linux, <code>' + esc(c.arp.alt) + '</code> works too.'), 'It has addresses but no makers, so most devices stay "not identified" unless you add the full scan or a DHCP list.', 'Ping the network first (or browse to a few devices) so the table is full.'];
    return ['Your router or DHCP server already lists every device it gave an address to, with its name. Look for Clients, DHCP leases or Devices, then Export or Download (CSV).', 'Any CSV with IP, MAC and name columns works - Zoned lets you pick the columns. dnsmasq’s lease file works as it is.', 'On a Windows server, this PowerShell exports the scope:'];
  }
  function loadHtml() {
    var c = C.gatherCommands(state.cmd);
    var which = state.cmd.which;
    var html = '<section class="card stepcard"><button class="link-btn" type="button" data-act="home">← Back</button><h1 style="margin:2px 0 8px">Check my network</h1>' +
      '<p class="muted lede">Two steps. Whatever you bring is read in this browser and goes nowhere else. Zoned itself never scans anything.</p>' +
      '<div class="warnbox" role="note"><span aria-hidden="true">⚠️</span><p><b>Only scan a network you are responsible for.</b> Scanning someone else’s network may be against the law. Run the full scan out of hours and tell the contractor first: old controllers can misbehave when scanned hard. The quick list and the DHCP list are the gentle options.</p></div>' +
      '<h2 style="margin-top:16px"><span class="k">1</span>Make a scan - or use one you have</h2>' +
      '<div class="fields"><label class="field"><span>The store network</span><input class="input code" id="cCidr" value="' + esc(state.cmd.cidr) + '" autocomplete="off" spellcheck="false" maxlength="20" inputmode="decimal"></label>' +
      '<div class="field"><span>Computer</span><div class="seg" role="group" aria-label="Computer"><button class="segb" type="button" data-act="cos" data-v="unix" aria-pressed="' + (state.cmd.os !== 'windows') + '">macOS / Linux</button><button class="segb" type="button" data-act="cos" data-v="windows" aria-pressed="' + (state.cmd.os === 'windows') + '">Windows</button></div></div></div>' +
      '<p class="small muted">Not sure of the network? On the computer, <code>' + (state.cmd.os === 'windows' ? 'ipconfig' : 'ifconfig') + '</code>' + (state.cmd.os === 'windows' ? '' : ' (or <code>ip addr</code> on Linux)') + ' shows its address - 192.168.1.20 means the network is 192.168.1.0/24.</p>' +
      '<div class="seg" role="group" aria-label="What to run" style="margin:6px 0 10px">' + CMD_KINDS.map(function (k) { return '<button class="segb" type="button" data-act="cwhich" data-v="' + k[0] + '" aria-pressed="' + (which === k[0]) + '">' + esc(k[1]) + '</button>'; }).join('') + '</div>';
    if (c.error) html += '<p class="err" role="alert">' + esc(c.error) + '</p>';
    else {
      var item = c[which];
      var box = '<div class="cmd"><pre aria-label="The command">' + esc(item.cmd) + '</pre><button class="btn ghost" type="button" data-act="copycmd">Copy</button></div>';
      var bullets = '<ul class="whatitdoes">' + cmdExplain(which, c).map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
      html += which === 'dhcp' ? bullets + '<div style="margin-top:8px">' + box + '</div>' : box + bullets;
      if (which === 'full' || which === 'quick' || which === 'udp') html += '<p class="small muted" style="margin-top:8px">' + (state.cmd.os === 'windows' ? 'Open Command Prompt as administrator. ' : 'It asks for your password because nmap needs admin rights to see MAC addresses. ') + 'No nmap yet? It is free from <a href="https://nmap.org/download" target="_blank" rel="noopener noreferrer">nmap.org</a>. Already have a scan saved with <code>-oA</code>, <code>-oG</code> or the screen output? Those work too.</p>';
    }
    html += '</section>';
    html += '<section class="card stepcard"><h2><span class="k">2</span>Drop the files here</h2>' +
      '<div class="drop" id="drop"><span class="ico" aria-hidden="true">📄</span><b>Drop scans, ARP tables or DHCP lists here</b><span class="small muted">Several at once is best - they are merged by MAC address</span>' +
      '<div class="btns"><label class="btn filepick">Choose files<input type="file" id="pickFile" multiple accept=".xml,.gnmap,.nmap,.txt,.csv,.leases,text/plain,text/csv,text/xml,application/xml" aria-label="Choose files"></label>' +
      '<button class="btn ghost" type="button" data-act="togglepaste">' + (state.showPaste ? 'Hide the paste box' : 'Paste text instead') + '</button></div></div>' +
      (state.showPaste ? '<label class="field" style="margin-top:12px"><span>Paste the output</span><textarea class="input code" id="pasteText" rows="8" spellcheck="false" placeholder="Nmap scan report for 192.168.1.1"></textarea></label><div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="addpaste">Add this</button></div>' : '') +
      '<div id="loadState" aria-live="polite"></div>' + filesHtml() + '</section>' + footer();
    return html;
  }
  function filesHtml() {
    if (!state.files.length) return '<p class="small muted" style="margin:10px 0 0">🔒 Read in this browser. Nothing is uploaded - not the file, not the addresses.</p>';
    var total = C.merge(state.files.map(function (f) { return f.parsed; })).devices.length;
    var html = '<ul class="files">' + state.files.map(function (f, i) {
      var p = f.parsed;
      var body = '<div class="fh"><div><div class="fn">' + esc(p.name) + '</div><div class="small muted">' + esc(p.label) + ' · ' + esc(plural(p.devices.length, 'device')) + (p.down ? ' · ' + esc(plural(p.down, 'host')) + ' down' : '') + '</div></div><button class="btn small ghost" type="button" data-act="rmfile" data-i="' + i + '" aria-label="Remove ' + esc(p.name) + '">Remove</button></div>';
      if (p.notes && p.notes.length) body += '<ul>' + p.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
      if (p.kind === 'dhcp-csv') {
        var m = p.mapping || {};
        var opts = function (sel) { return '<option value="-1"' + (sel === -1 ? ' selected' : '') + '>(none)</option>' + p.columns.map(function (c, j) { return '<option value="' + j + '"' + (sel === j ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join(''); };
        body += '<details' + (m.ip === -1 && m.mac === -1 ? ' open' : '') + '><summary>Columns: ' + esc(['ip', 'mac', 'hostname'].map(function (k) { return m[k] >= 0 ? (k === 'ip' ? 'IP' : k === 'mac' ? 'MAC' : 'Name') + ' = ' + p.columns[m[k]] : null; }).filter(Boolean).join(', ') || 'not found yet') + '</summary><div class="fields">' +
          [['ip', 'IP address'], ['mac', 'MAC address'], ['hostname', 'Name'], ['vendor', 'Maker (if any)']].map(function (k) { return '<label class="field"><span>' + k[1] + '</span><select class="input" data-map="' + k[0] + '" data-i="' + i + '">' + opts(m[k[0]]) + '</select></label>'; }).join('') + '</div></details>';
      }
      return '<li>' + body + '</li>';
    }).join('') + '</ul>';
    html += '<div class="btns" style="margin-top:12px"><button class="btn big" type="button" data-act="runcheck"' + (total ? '' : ' disabled') + '>' + (total ? 'Check ' + esc(plural(total, 'device')) : 'No devices yet') + '</button><button class="btn ghost" type="button" data-act="clearfiles">Remove all</button></div>';
    return html;
  }
  function redrawFiles() {
    var box = $('#main .stepcard:last-of-type');
    var old = $('.files', box), btns = old ? old.nextElementSibling : null, hint = $('p.small.muted:last-child', box);
    if (old) old.remove(); if (btns) btns.remove();
    if (hint && /Nothing is uploaded/.test(hint.textContent)) hint.remove();
    var tmp = document.createElement('div');
    tmp.innerHTML = filesHtml();
    while (tmp.firstChild) box.appendChild(tmp.firstChild);
  }
  function wireLoad() {
    var ci = $('#cCidr');
    if (ci) ci.addEventListener('change', function () { state.cmd.cidr = ci.value.trim(); if (C.gatherCommands(state.cmd).error === undefined) keep(K_CMD, state.cmd); draw(); var again = $('#cCidr'); if (again) again.focus(); });
    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); readFiles(e.dataTransfer && e.dataTransfer.files); });
    $('#pickFile').addEventListener('change', function (e) { readFiles(e.target.files); e.target.value = ''; });
  }
  /** Bytes -> text: UTF-8, or UTF-16 (PowerShell's `>` writes UTF-16 with a BOM). */
  function decode(buf) {
    var b = new Uint8Array(buf);
    try {
      if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
      if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
      var zeros = 0; for (var i = 1; i < Math.min(b.length, 400); i += 2) if (b[i] === 0) zeros++;
      if (b.length > 8 && zeros > Math.min(b.length, 400) / 4) return new TextDecoder('utf-16le').decode(b);
      return new TextDecoder('utf-8').decode(b);
    } catch (e) { return ''; }
  }
  function readFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    var box = $('#loadState');
    if (!files.length) return;
    if (state.files.length + files.length > C.LIMITS.files) { box.innerHTML = '<p class="err" role="alert">' + esc('Up to ' + C.LIMITS.files + ' files at once.') + '</p>'; return; }
    var big = files.filter(function (f) { return f.size > C.LIMITS.bytes; });
    if (big.length) { box.innerHTML = '<p class="err" role="alert">' + esc(big[0].name + ' is over ' + Math.round(C.LIMITS.bytes / 1048576) + ' MB. Scan one network at a time.') + '</p>'; return; }
    box.innerHTML = '<p class="small muted">Reading…</p>';
    Promise.all(files.map(function (f) { return f.arrayBuffer().then(function (buf) { return { name: f.name, text: decode(buf) }; }); })).then(function (got) {
      got.forEach(function (g) { addText(g.text, g.name); });
      box.innerHTML = '';
      redrawFiles();
    }, function () { box.innerHTML = '<p class="err" role="alert">That file could not be read.</p>'; });
  }
  function addText(text, name) {
    var parsed = C.readInput(text, name);
    state.files.push({ name: name, text: text, mapping: null, parsed: parsed });
  }

  /* ---------------- the strip, findings ---------------- */

  function stripHtml() {
    var a = state.a;
    var src = state.demo ? '<b>Example: ' + esc(D.title) + '</b> <span class="sub">· made up · not saved</span>' : '<b>Your network</b> <span class="sub">· ' + esc(plural(a.inputs.length, 'file')) + ', read on this device</span>';
    return '<div class="strip noprint"><p>' + src + '<br><span class="sub">' + esc(a.inputs.map(function (i) { return i.name; }).join(', ')) + '</span></p><div class="btns">' +
      (state.demo ? '<button class="btn light small" type="button" data-act="gocheck">Check my network</button>' : '<button class="btn ghost small" type="button" data-act="gocheck">Change files</button>') + '</div></div>';
  }
  function statsHtml(a) {
    var s = a.stats.byRole;
    return '<dl class="stats"><div><dt>Devices</dt><dd>' + esc(C.fmtInt(a.stats.devices)) + '</dd></div><div><dt>Building &amp; OT</dt><dd>' + esc(C.fmtInt(a.stats.ot)) + '</dd></div><div><dt>Tills and card readers</dt><dd>' + esc(C.fmtInt(s.pos)) + '</dd></div><div><dt>Not identified</dt><dd>' + esc(C.fmtInt(s.unknown)) + '</dd></div></dl>';
  }
  function nowPlanHtml(a) {
    var s = a.stats.byRole;
    var order = ['refrigeration', 'hvac', 'lighting', 'bms', 'remote', 'iot', 'pos', 'office', 'printer', 'camera', 'network', 'guest', 'unknown'];
    var nets = a.stats.networks;
    var WORD = { refrigeration: ['refrigeration', 'refrigeration'], hvac: ['HVAC', 'HVAC'], lighting: ['lighting', 'lighting'], bms: ['BMS PC', 'BMS PCs'], remote: ['remote-access box', 'remote-access boxes'], iot: ['smart device', 'smart devices'], pos: ['till or reader', 'tills and readers'], office: ['office PC', 'office PCs'], printer: ['printer', 'printers'], camera: ['camera', 'cameras'], network: ['network device', 'network devices'], guest: ['phone or guest', 'phones and guests'], unknown: ['unknown', 'unknown'] };
    var chips = order.filter(function (r) { return s[r]; }).map(function (r) { return '<li class="' + (ROLES[r].ot ? 'ot' : '') + '"><span aria-hidden="true">' + ROLES[r].icon + '</span>' + esc(s[r] + ' ' + WORD[r][s[r] === 1 ? 0 : 1]) + '</li>'; }).join('');
    var now = '<div class="nowbox"><p class="lab" style="margin:0">Now</p><b>' + esc(nets.length === 1 ? 'One flat network: ' + nets[0] : plural(nets.length, 'network')) + '</b><ul class="chips" style="margin:0">' + chips + '</ul><p class="small muted" style="margin:0">' + esc(nets.length === 1 ? 'Every device can reach every other one.' : 'Check the firewall between them blocks traffic both ways.') + '</p></div>';
    var plan = '<div><p class="lab">The plan</p><div class="zonemini">' + a.plan.zones.map(function (z) { return '<div class="zm z-' + z.id + '"><b><span aria-hidden="true">' + z.icon + '</span> ' + esc(z.name) + '</b><span>' + esc(plural(z.devices.length, 'device') + ' · VLAN ' + z.vlan) + '</span></div>'; }).join('') + '</div><div class="btns" style="margin-top:10px"><button class="btn small" type="button" data-act="tab" data-tab="plan">See the zone plan →</button></div></div>';
    return '<section class="card"><div class="nowplan">' + now + plan + '</div></section>';
  }
  function findingsHtml() {
    var a = state.a, v = a.verdict;
    var tone = v.tone === 'risk' ? sevPill('high', 'High risk') : v.tone === 'check' ? sevPill('medium', 'Worth fixing') : '<span class="pill s-ok"><span aria-hidden="true">✓</span>Looks separated</span>';
    var html = '<section class="card verdict t-' + esc(v.tone) + '"><div class="row">' + tone + '</div><h1>' + esc(v.headline) + '</h1><p class="vsub">' + esc(v.sub) + '</p>' + statsHtml(a) + '</section>';
    if (a.stats.devices) html += nowPlanHtml(a);
    if (a.notes.length) html += '<div class="note" role="note" style="margin-top:14px"><b>Read with notes</b><ul style="margin:6px 0 0;padding-left:20px">' + a.notes.map(function (n) { return '<li class="anywhere">' + esc(n) + '</li>'; }).join('') + '</ul></div>';
    html += '<section class="sec" style="margin-top:14px"><div class="sec-head"><h2>' + esc(plural(a.findings.length, 'finding')) + ', worst first</h2><span class="small muted">Tap one for what it means and the fix.</span></div><ul class="flist">' + a.findings.map(function (f, i) { return '<li>' + findingHtml(f, i) + '</li>'; }).join('') + '</ul></section>';
    return html;
  }
  function findingHtml(f, i) {
    var a = state.a;
    var devs = f.devices.map(function (id) { return a.byId[id]; }).filter(Boolean);
    var shown = devs.slice(0, 16);
    return '<details class="find e-' + f.severity + '" data-find="' + i + '"' + (state.openFind[i] ? ' open' : '') + '><summary><span class="ft">' + esc(f.title) + '</span><span class="chev" aria-hidden="true">›</span><span class="fmeta">' + sevPill(f.severity) + (devs.length ? '<span>' + esc(plural(devs.length, 'device')) + '</span>' : '') + '</span></summary>' +
      '<div class="fbody"><p>' + esc(f.detail) + '</p><div class="fix"><b>Fix: </b>' + esc(f.fix) + '</div>' +
      (shown.length ? '<div><p class="lab">Devices</p><div class="devchips">' + shown.map(devChip).join('') + (devs.length > shown.length ? '<button class="btn small ghost" type="button" data-act="tab" data-tab="devices">+' + esc(devs.length - shown.length) + ' more in Devices</button>' : '') + '</div></div>' : '') +
      '<div class="btns"><button class="link-btn" type="button" data-act="tab" data-tab="' + esc(f.tab) + '">' + esc({ plan: 'See the zone plan →', contractor: 'See the contractor checklist →', devices: 'See the devices →' }[f.tab] || 'See more →') + '</button></div></div></details>';
  }

  /* ---------------- devices ---------------- */

  var GROUPS = [['ot', 'Building & OT', function (r) { return ROLES[r].ot; }], ['pos', 'Payments', function (r) { return r === 'pos'; }], ['office', 'Office and printers', function (r) { return r === 'office' || r === 'printer'; }], ['camera', 'Cameras', function (r) { return r === 'camera'; }], ['network', 'Network gear', function (r) { return r === 'network'; }], ['guest', 'Guest and personal', function (r) { return r === 'guest'; }], ['unknown', 'Not identified', function (r) { return r === 'unknown'; }]];
  var GROUP_ICON = { ot: '🏭', pos: '💳', office: '🖥️', camera: '📹', network: '🌐', guest: '📱', unknown: '❓' };
  function matches(d) {
    var f = state.filter;
    if (f === 'ot' && !ROLES[d.cls.role].ot) return false;
    if (f === 'pos' && d.cls.role !== 'pos') return false;
    if (f === 'unknown' && d.cls.role !== 'unknown') return false;
    if (f === 'issues' && !d.findings.length) return false;
    var q = state.q.toLowerCase();
    if (q && [d.name, d.ip, d.mac, d.vendor].concat(d.hostnames).join(' ').toLowerCase().indexOf(q) === -1) return false;
    return true;
  }
  function devicesHtml() {
    var a = state.a;
    var n = function (fn) { return a.devices.filter(fn).length; };
    var counts = { all: a.devices.length, ot: a.stats.ot, pos: a.stats.byRole.pos, unknown: a.stats.byRole.unknown, issues: n(function (d) { return d.findings.length; }) };
    var html = '';
    if (a.stats.byRole.unknown) html += '<section class="card" style="margin-bottom:14px"><div class="row spread"><div style="min-width:0;flex:1 1 260px"><h2 style="margin:0 0 4px">✨ ' + esc(plural(a.stats.byRole.unknown, 'device') + ' not identified') + '</h2><p class="small muted" style="margin:0">Open one to set what it is, or let AI suggest from the maker and ports. You see exactly what is sent first - never an address.</p></div><button class="btn ai" type="button" data-act="identify">Help me identify the unknowns</button></div></section>';
    html += '<div class="filters"><div class="seg" role="group" aria-label="Show">' + [['all', 'All'], ['ot', 'Building & OT'], ['pos', 'Payments'], ['unknown', 'Not identified'], ['issues', 'With issues']].map(function (f) { return '<button class="segb" type="button" data-act="filter" data-v="' + f[0] + '" aria-pressed="' + (state.filter === f[0]) + '">' + esc(f[1] + ' · ' + counts[f[0]]) + '</button>'; }).join('') + '</div>' +
      '<input class="input search" id="dq" type="search" placeholder="Search name, address or maker" aria-label="Search devices" value="' + esc(state.q) + '" autocomplete="off" spellcheck="false"></div><div id="dlist">' + deviceGroupsHtml() + '</div>';
    return html;
  }
  function deviceGroupsHtml() {
    var a = state.a, html = '', any = false;
    GROUPS.forEach(function (g) {
      var list = a.devices.filter(function (d) { return g[2](d.cls.role) && matches(d); });
      if (!list.length) return;
      any = true;
      html += '<section class="group"><h3><span aria-hidden="true">' + GROUP_ICON[g[0]] + '</span>' + esc(g[1]) + ' <span class="muted small">' + list.length + '</span></h3><ul class="dlist">' + list.map(deviceRow).join('') + '</ul></section>';
    });
    return any ? html : '<p class="muted">Nothing matches.</p>';
  }
  function deviceRow(d) {
    var sub = [d.ip, d.vendor && !/^private$/i.test(d.vendor) ? d.vendor : '', d.randomMac ? 'private address' : ''].filter(Boolean).join(' · ');
    var issues = d.findings.length;
    var worst = issues ? state.a.findings.filter(function (f) { return d.findings.indexOf(f.id) !== -1; })[0].severity : '';
    return '<li><button class="drow" type="button" data-act="device" data-id="' + esc(d.id) + '"><span class="ico" aria-hidden="true">' + ROLES[d.cls.role].icon + '</span><span><span class="nm">' + esc(d.name) + '</span><span class="sub">' + esc(sub) + '</span></span><span class="rt"><span class="conf">' + esc(ROLES[d.cls.role].short + ' · ' + C.confWord(d.cls.conf)) + '</span>' + (issues ? '<span class="issues s-' + worst + '" style="background:none"><span aria-hidden="true">' + SEV[worst].icon + '</span>' + esc(plural(issues, 'issue')) + '</span>' : '') + '</span></button></li>';
  }
  function wireDevices() {
    var q = $('#dq');
    if (q) q.addEventListener('input', function () { state.q = q.value.slice(0, 80); $('#dlist').innerHTML = deviceGroupsHtml(); });
  }

  function openDevice(id) {
    var a = state.a, d = a.byId[id];
    if (!d) return;
    var cls = d.cls;
    var groups = C.evidenceByRole(cls);
    var auto = cls.auto;
    var ports = C.openPorts(d);
    var html = '<h2><span aria-hidden="true">' + ROLES[cls.role].icon + '</span> ' + esc(d.name) + '</h2>';
    html += '<div class="row" style="margin-bottom:12px">' + rolePill(cls.role) + '<span class="conf">' + esc(C.confWord(cls.conf)) + '</span>' + (cls.alt ? '<span class="small muted">' + esc('Could also be: ' + ROLES[cls.alt].label) + '</span>' : '') + '</div>';
    html += '<section><dl class="kv"><dt>Address</dt><dd class="mono">' + esc(d.ip || '-') + '</dd><dt>MAC</dt><dd class="mono">' + esc(d.mac || 'not in these files') + (d.randomMac ? ' <span class="small muted">(a private, randomised address)</span>' : '') + '</dd><dt>Maker</dt><dd>' + esc(d.vendor || 'not reported') + '</dd>' +
      (d.hostnames.length ? '<dt>Names</dt><dd>' + esc(d.hostnames.join(', ')) + '</dd>' : '') + (d.os ? '<dt>System</dt><dd>' + esc(d.os.name) + '</dd>' : '') +
      '<dt>Seen in</dt><dd>' + esc(d.sources.map(function (s) { return { 'nmap-xml': 'nmap XML', 'nmap-normal': 'nmap output', 'nmap-grepable': 'nmap grepable', arp: 'ARP table', dhcp: 'DHCP list' }[s] || s; }).join(', ')) + '</dd>' +
      '<dt>Goes in</dt><dd>' + esc(C.ZONES[d.zone].name + ' (VLAN ' + C.ZONES[d.zone].vlan + ')') + '</dd></dl>' +
      (d.conflict && d.conflict.length ? '<p class="small err">' + esc('This address was also seen with ' + d.conflict.join(', ') + '.') + '</p>' : '') + '</section>';
    // Is this right?
    html += '<section class="note"><label class="field"><span>Is this right?</span><select class="input" id="roleSel">' + C.ROLE_KEYS.map(function (k) { return '<option value="' + k + '"' + (k === cls.role ? ' selected' : '') + '>' + esc(ROLES[k].icon + ' ' + ROLES[k].label) + '</option>'; }).join('') + '</select></label>' +
      '<p class="small muted" style="margin:6px 0 0">' + esc(cls.overridden ? 'Set by you. Our guess was: ' + ROLES[auto.role].label + ' (' + C.confWord(auto.conf) + ').' : 'Change it and the findings and plan update.' + (state.demo ? ' (The example is not saved.)' : ' Saved on this device only.')) + '</p>' +
      (cls.overridden ? '<button class="btn small ghost" type="button" data-act="resetrole" data-id="' + esc(d.id) + '" style="margin-top:8px">Back to our guess</button>' : '') + '</section>';
    var sg = state.suggestions[d.id];
    if (sg) html += '<section class="sugg"><p class="lab" style="margin:0">AI suggests</p><div class="row">' + rolePill(sg.role) + '<span class="conf">' + esc(C.confWord(sg.confidence)) + '</span></div><p>' + esc(sg.why) + '</p>' + (sg.check ? '<p class="small"><b>Check on site:</b> ' + esc(sg.check) + '</p>' : '') + (sg.role !== cls.role ? '<div><button class="btn small" type="button" data-act="usesugg" data-id="' + esc(d.id) + '">Use this</button></div>' : '') + '</section>';
    else if (cls.role === 'unknown') html += '<section><button class="btn ai" type="button" data-act="identify" data-id="' + esc(d.id) + '">Ask AI what this is</button></section>';
    // Why we think so.
    html += '<section><p class="lab">Why we think so</p>' + (groups.length ? '<ul class="evlist">' + groups.map(function (g) {
      return '<li class="evgroup' + (g.role === auto.role ? ' win' : '') + '"><h4><span aria-hidden="true">' + ROLES[g.role].icon + '</span>' + esc(ROLES[g.role].label) + ' <span class="w">' + esc('score ' + g.w) + '</span>' + (g.role === auto.role ? ' <span class="small muted">· our guess</span>' : '') + '</h4><ul>' + g.items.map(function (e) { return '<li>' + esc(e.text) + ' <span class="w">+' + e.w + '</span></li>'; }).join('') + '</ul></li>';
    }).join('') + '</ul>' : '<p class="muted">Nothing here matches a maker, name or port Zoned knows. Find it by its address on the router or switch - or ask AI below.</p>') + '</section>';
    // Ports.
    html += '<section><p class="lab">' + esc(ports.length ? plural(ports.length, 'open port') : 'Open ports') + '</p>' + (ports.length ? '<div class="tablebox"><table class="t"><thead><tr><th>Port</th><th>What it is</th><th>It says</th></tr></thead><tbody>' + ports.map(function (p) { return '<tr><td class="mono">' + esc(p.port + '/' + p.proto) + '</td><td>' + esc(C.portLabel(p)) + '</td><td class="anywhere">' + esc([p.product, p.version, p.title ? '“' + p.title + '”' : ''].filter(Boolean).join(' ') || '-') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="muted small">None in these files' + (d.sources.indexOf('nmap-xml') === -1 && d.sources.indexOf('nmap-normal') === -1 && d.sources.indexOf('nmap-grepable') === -1 ? ' - add an nmap scan to see them.' : '.') + '</p>') + '</section>';
    // Findings.
    var fs = state.a.findings.filter(function (f) { return d.findings.indexOf(f.id) !== -1; });
    if (fs.length) html += '<section><p class="lab">Findings</p><ul class="flist">' + fs.map(function (f) { return '<li class="row">' + sevPill(f.severity) + '<span class="anywhere">' + esc(f.title) + '</span></li>'; }).join('') + '</ul></section>';
    // Note.
    html += '<section><label class="field"><span>Your note</span><textarea class="input" id="devNote" rows="3" maxlength="' + C.LIMITS.noteLen + '" placeholder="Where it is, who installed it, what it runs">' + esc(state.saved.notes[d.id] || '') + '</textarea></label><p class="small muted" style="margin:6px 0 0">' + (state.demo ? 'The example is not saved.' : 'Saved on this device only, and in your report.') + '</p></section>';
    sheet(html, function (root) {
      $('#roleSel', root).addEventListener('change', function (e) { setRole(d.id, e.target.value); });
      $('#devNote', root).addEventListener('input', function (e) { var v = e.target.value.slice(0, C.LIMITS.noteLen); if (v) state.saved.notes[d.id] = v; else delete state.saved.notes[d.id]; saveSaved(); });
    });
  }
  function setRole(id, role) {
    var d = state.a.byId[id];
    if (!d || !ROLES[role]) return;
    if (role === d.cls.auto.role) delete state.saved.roles[id]; else state.saved.roles[id] = role;
    saveSaved();
    analyseNow();
    drawTab();
    var keepOpen = !$('#sheet').hidden;
    if (keepOpen) openDevice(id);
    toast(role === state.a.byId[id].cls.auto.role ? 'Back to our guess - the plan is updated' : 'Set to ' + ROLES[role].label + ' - the plan is updated');
  }

  /* ---------------- the plan ---------------- */

  function planHtml() {
    var a = state.a, p = a.plan;
    var html = '<section class="card"><h1 style="font-size:1.5rem">The zone plan</h1><p class="muted lede">' + esc(plural(p.zones.length, 'zone')) + ', each its own VLAN and subnet, with nothing allowed between them except the rules below. The VLAN numbers and subnets are suggestions (' + esc(p.scheme) + '.x.0/24, chosen not to clash with what you use now) - change them to suit.</p>' +
      '<div class="zones">' + p.zones.map(function (z) {
        var devs = z.devices.map(function (id) { return a.byId[id]; });
        var first = devs.slice(0, 8), rest = devs.slice(8);
        return '<section class="zone z-' + z.id + '"><h3><span aria-hidden="true">' + z.icon + '</span>' + esc(z.name) + '</h3><div class="net"><span>VLAN <b>' + z.vlan + '</b></span><span>Subnet <b>' + esc(z.subnet) + '</b></span><span>Gateway <b>' + esc(z.gateway) + '</b></span></div><p>' + esc(z.purpose) + '</p>' +
          (devs.length ? '<div class="devchips">' + first.map(devChip).join('') + '</div>' + (rest.length ? '<details><summary>' + esc('+' + rest.length + ' more') + '</summary><div class="devchips">' + rest.map(devChip).join('') + '</div></details>' : '') : '<p class="small">Nothing yet - your switches, access points and firewall belong here. Move their admin addresses in when you build it.</p>') + '</section>';
      }).join('') + '</div></section>';
    html += '<section class="card"><div class="sec-head"><h2>🔥 Firewall rules between zones</h2><button class="btn small ghost" type="button" data-act="copyrules">Copy the rules</button></div><p class="small muted lede">Read top to bottom. Everything not allowed is blocked. Nothing in Building &amp; OT may reach Payments.</p>' + rulesTable(a.rules) + '</section>';
    html += '<section class="card"><h2>How to build it</h2><ol class="steps">' + C.STEPS.order.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<h3 style="margin-top:16px">On your gear</h3><div class="seg" role="group" aria-label="Your gear" style="margin:6px 0 10px">' + C.STEPS.gear.map(function (g) { return '<button class="segb" type="button" data-act="gear" data-v="' + g.id + '" aria-pressed="' + (state.gear === g.id) + '">' + esc(g.name) + '</button>'; }).join('') + '</div>' +
      (function () { var g = C.STEPS.gear.filter(function (x) { return x.id === state.gear; })[0] || C.STEPS.gear[0]; return '<ol class="steps">' + g.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>'; }()) +
      '<p class="small muted" style="margin-top:10px">These are the general steps; menu names vary by version. If someone else manages your firewall, send them the report - it has the zones and rules.</p></section>';
    return html;
  }
  function rulesTable(rules) {
    return '<div class="tablebox"><table class="t stack"><thead><tr><th>#</th><th>From</th><th>To</th><th>Service</th><th>Action</th><th>Why</th></tr></thead><tbody>' + rules.map(function (r, i) {
      return '<tr><td class="num" data-label="Rule">' + (i + 1) + '</td><td data-label="From">' + esc(r.from) + '</td><td data-label="To">' + esc(r.to) + '</td><td data-label="Service" class="anywhere">' + esc(r.service) + '</td><td data-label="Action">' + actHtml(r.action) + '</td><td data-label="Why" class="small">' + esc(r.why) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function rulesText(rules) { return rules.map(function (r, i) { return (i + 1) + '. ' + r.action.toUpperCase() + '  ' + r.from + ' -> ' + r.to + '  [' + r.service + ']  ' + r.why; }).join('\n') + '\n'; }

  /* ---------------- the contractor ---------------- */

  function letterText() {
    if (state.saved.letter != null) return state.saved.letter;
    return C.letter(state.a.devices, state.a.plan, state.letterFields);
  }
  function contractorHtml() {
    var a = state.a;
    var list = C.checklist(a.devices);
    var otsv = C.otServices(a.devices);
    var done = list.filter(function (c) { return state.saved.checks[c.id]; }).length;
    var html = '<section class="card"><h1 style="font-size:1.5rem">Working with the contractor</h1><p class="muted lede">The refrigeration and HVAC contractors still need to reach their equipment - through your firewall, not around it. Ask them these, and send the letter.</p>' +
      (otsv.length ? '<div class="note"><b>Their remote access needs (from your scan):</b><div class="devchips" style="margin-top:6px">' + otsv.map(function (s) { return '<span class="chip">' + esc(s.label + ' ' + s.port + '/' + s.proto) + '</span>'; }).join('') + '</div></div>' : '') + '</section>';
    html += '<section class="card"><div class="sec-head"><h2>✅ Contractor checklist</h2><span class="small muted">' + esc(done + ' of ' + list.length + ' done') + '</span></div><ul class="checks">' + list.map(function (c) {
      var on = Boolean(state.saved.checks[c.id]);
      return '<li' + (on ? ' class="done"' : '') + '><label><input type="checkbox" data-check="' + esc(c.id) + '"' + (on ? ' checked' : '') + '><span>' + esc(c.text) + '</span></label></li>';
    }).join('') + '</ul></section>';
    var f = state.letterFields;
    html += '<section class="card"><div class="sec-head"><h2>✉️ The letter</h2><div class="btns"><button class="btn small" type="button" data-act="copyletter">Copy</button><button class="btn small ghost" type="button" data-act="dlletter">Download</button></div></div>' +
      '<p class="small muted lede">It says what you are changing, which ports their remote access will get, asks them to stop installing their own modems, and asks how alarms reach them. Edit anything.</p>' +
      '<div class="fields">' + [['business', 'Your business'], ['you', 'Your name'], ['contractor', 'The contractor'], ['when', 'When you would like to do it']].map(function (k) { return '<label class="field"><span>' + k[1] + '</span><input class="input" data-lf="' + k[0] + '" value="' + esc(f[k[0]] || '') + '" maxlength="80" autocomplete="off"></label>'; }).join('') + '</div>' +
      (state.saved.letter != null ? '<p class="small muted">You have edited the letter, so the fields above no longer change it. <button class="link-btn" type="button" data-act="rebuildletter">Rebuild it from the fields</button></p>' : '') +
      '<label class="field"><span class="vh">The letter</span><textarea class="input letter" id="letter" spellcheck="true">' + esc(letterText()) + '</textarea></label></section>';
    return html;
  }
  function wireContractor() {
    $$('[data-lf]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        state.letterFields[inp.getAttribute('data-lf')] = inp.value.slice(0, 80);
        if (!state.demo) keep(K_LETTER, state.letterFields);
        if (state.saved.letter == null) $('#letter').value = letterText();
      });
    });
    var ta = $('#letter');
    ta.addEventListener('input', function () {
      var fresh = C.letter(state.a.devices, state.a.plan, state.letterFields);
      state.saved.letter = ta.value === fresh ? null : ta.value.slice(0, 20000);
      saveSaved();
    });
  }

  /* ---------------- the report ---------------- */

  function extras() { return { date: today(), title: state.demo ? D.title : state.letterFields.business, notes: state.saved.notes }; }
  function reportHtml() {
    var a = state.a, x = extras();
    var html = '<section class="card noprint"><h1 style="font-size:1.5rem">The report</h1><p class="muted lede">For the owner, the person who runs your firewall, or your card processor. Devices with their addresses, makers, roles and evidence; the findings; the zone plan and the rules. Made on this device.</p>' +
      '<div class="btns"><button class="btn" type="button" data-act="print">Print or save as PDF</button><button class="btn ghost" type="button" data-act="md">Download Markdown</button><button class="btn ghost" type="button" data-act="json">Download JSON</button><button class="btn ghost" type="button" data-act="copymd">Copy Markdown</button></div></section>';
    html += '<section class="card noprint"><div class="row spread"><div style="flex:1 1 260px;min-width:0"><h2 style="margin:0 0 4px">Saved on this device</h2><p class="small muted" style="margin:0">' + esc(state.demo ? 'Nothing - the example is never saved.' : savedCount() ? plural(savedCount(), 'change') + ' (roles you set, notes, ticks, the letter) for these files, in this browser only. Never uploaded.' : 'Nothing yet. Roles you set, notes and ticks are kept in this browser only, for these files.') + '</p></div>' + (!state.demo && savedCount() ? '<button class="btn small ghost" type="button" data-act="clearsaved">Clear</button>' : '') + '</div></section>';
    // The printable report.
    html += '<section class="card" id="report"><h2>' + esc('Zoned network report' + (x.title ? ' - ' + x.title : '')) + '</h2><p class="small muted">' + esc(x.date + ' · read from ' + a.inputs.map(function (i) { return i.name + ' (' + i.label + ')'; }).join(', ') + '. Zoned reads scans you already ran; it never scans anything.') + '</p>' +
      '<p><b>' + esc(a.verdict.headline) + '</b><br><span class="muted">' + esc(a.verdict.sub) + '</span></p>' +
      '<h3>Findings</h3><ol>' + a.findings.map(function (f) { return '<li style="margin:4px 0"><b>' + esc(SEV[f.severity].icon + ' ' + SEV[f.severity].word + ': ' + f.title) + '</b><br><span class="small">' + esc(f.fix) + '</span></li>'; }).join('') + '</ol>' +
      '<h3>Zones</h3><div class="tablebox"><table class="t"><thead><tr><th>Zone</th><th>VLAN</th><th>Subnet</th><th>Devices</th></tr></thead><tbody>' + a.plan.zones.map(function (z) { return '<tr><td>' + esc(z.name) + '</td><td>' + z.vlan + '</td><td class="mono">' + esc(z.subnet) + '</td><td>' + z.devices.length + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<h3 style="margin-top:14px">Firewall rules</h3>' + rulesTable(a.rules) +
      '<h3 style="margin-top:14px">Devices</h3><div class="tablebox"><table class="t wide"><thead><tr><th>IP</th><th>MAC</th><th>Maker</th><th>Name</th><th>Role</th><th>Sure?</th><th>Zone</th><th>Why</th></tr></thead><tbody>' + a.devices.map(function (d) {
        var why = d.cls.overridden ? 'Set by you' : C.evidenceTexts(d).slice(0, 2).join('; ');
        return '<tr><td class="mono">' + esc(d.ip || '-') + '</td><td class="mono">' + esc(d.mac || '-') + '</td><td>' + esc(d.vendor || '-') + '</td><td class="anywhere">' + esc(d.name) + '</td><td>' + esc(ROLES[d.cls.role].label) + '</td><td>' + esc(C.confWord(d.cls.conf)) + '</td><td>' + esc(C.ZONES[d.zone].name) + '</td><td class="small anywhere">' + esc(why || '-') + (state.saved.notes[d.id] ? '<br><i>' + esc('Note: ' + state.saved.notes[d.id]) + '</i>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="small muted" style="margin-top:12px">Card-payment scope (PCI DSS) depends on your processor and assessor - this report is not legal or compliance advice.</p></section>';
    return html;
  }
  function fname(ext) { return 'zoned-' + today() + ext; }

  /* ---------------- AI: help me identify the unknowns ---------------- */

  function hasClues(d) { return Boolean((d.vendor && !/^private$/i.test(d.vendor)) || d.hostnames.length || C.openPorts(d).length || (d.vendor && C.openPorts(d).length)); }
  function openIdentify(onlyId) {
    var a = state.a;
    var unknowns = a.devices.filter(function (d) { return d.cls.role === 'unknown'; });
    if (!unknowns.length) { toast('Every device has a role. Open one to change it.'); return; }
    var picked = {};
    unknowns.forEach(function (d) { if (hasClues(d) && (!onlyId || onlyId === d.id)) picked[d.id] = 1; });
    var payload = function () { return C.identifyPayload(a, unknowns.filter(function (d) { return picked[d.id]; }).map(function (d) { return d.id; }).slice(0, C.LIMITS.identifyDevices)); };
    var lead = '<p>AI reads the clues Zoned has about each device you tick - the maker, its names and what answered on which port - and suggests what it is and how to check on site. You decide whether to use a suggestion.</p>' +
      '<div class="warnbox" role="note"><span aria-hidden="true">🔒</span><p><b>No IP or MAC address is sent.</b> Anything shaped like an address is replaced with [address], and nothing about your other devices goes. Sent to an AI provider (Anthropic) once, and not stored.</p></div>';
    var listHtml = '<ul class="picklist" style="margin-top:12px">' + unknowns.map(function (d) {
      var ok = hasClues(d);
      var what = [d.vendor && !/^private$/i.test(d.vendor) ? C.clean(d.vendor, 60) : '', d.hostnames[0] ? C.clean(d.hostnames[0], 60) : '', C.openPorts(d).length ? 'ports ' + C.openPorts(d).map(function (p) { return p.port; }).slice(0, 6).join(', ') : ''].filter(Boolean).join(' · ');
      return '<li><label class="' + (ok ? '' : 'off') + '"><input type="checkbox" data-pick="' + esc(d.id) + '"' + (picked[d.id] ? ' checked' : '') + (ok ? '' : ' disabled') + '><span><b>' + esc(d.name) + '</b> <span class="small muted mono">' + esc(d.ip || '') + '</span><br><span class="small muted">' + esc(ok ? what : 'Nothing to go on - no maker, name or open port. Find it on the switch.') + '</span></span></label></li>';
    }).join('') + '</ul>';
    var sentBox = '<p class="small muted" style="margin:12px 0 6px"><b>Exactly what would be sent:</b></p><pre class="sent" id="idPayload" aria-label="What would be sent">' + esc(JSON.stringify(payload().body, null, 2)) + '</pre>';
    var wirePicks = function (root) {
      $$('[data-pick]', root).forEach(function (cb) {
        cb.addEventListener('change', function () {
          if (cb.checked) picked[cb.getAttribute('data-pick')] = 1; else delete picked[cb.getAttribute('data-pick')];
          $('#idPayload', root).textContent = JSON.stringify(payload().body, null, 2);
          var send = $('#idSend', root); if (send) send.disabled = !payload().body.devices.length;
        });
      });
    };
    if (!signedIn()) {
      sheet('<h2>✨ Help me identify the unknowns</h2>' + lead + listHtml + sentBox +
        '<p class="small muted" style="margin-top:12px">It uses about a cent of AI credit, so it needs a free account (it comes with $2). Everything else in Zoned is free and needs no account.</p>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="signin-identify">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>', wirePicks);
      return;
    }
    var sentDetails = '<details open id="idSentBox" style="margin-top:12px"><summary class="row" style="min-height:44px;cursor:pointer"><b id="idSentLabel">Exactly what will be sent</b></summary><pre class="sent" id="idPayload" aria-label="What will be sent">' + esc(JSON.stringify(payload().body, null, 2)) + '</pre></details>';
    sheet('<h2>✨ Help me identify the unknowns</h2><div id="idLead">' + lead + listHtml + '</div>' + sentDetails + '<div id="idErr"></div><div class="btns" style="margin-top:12px" id="idActs"><button class="btn" type="button" id="idSend"' + (payload().body.devices.length ? '' : ' disabled') + '>Ask AI</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div><p class="small muted" style="margin-top:8px" id="idCost">About a cent of AI credit.</p><div id="idOut"></div>', function (root) {
      wirePicks(root);
      var send = $('#idSend', root);
      send.addEventListener('click', function () {
        var p = payload();
        if (!p.body.devices.length) return;
        send.disabled = true; send.textContent = 'Asking…';
        api('POST', 'api/identify', p.body).then(function (r) {
          var res = C.cleanIdentification(r.result, p.refs);
          if (!res) throw Object.assign(new Error('That answer had nothing usable in it. Try again.'), { status: 422 });
          res.devices.forEach(function (s) { state.suggestions[p.refs[s.ref]] = s; });
          $('#idLead', root).hidden = true; $('#idActs', root).hidden = true; $('#idCost', root).hidden = true;
          $('#idSentBox', root).open = false; $('#idSentLabel', root).textContent = 'What was sent';
          $('#idOut', root).innerHTML = '<p class="lab" style="margin-top:14px">Suggestions - yours to accept</p><div style="display:grid;gap:10px">' + res.devices.map(function (s) {
            var d = a.byId[p.refs[s.ref]];
            return '<div class="sugg"><b>' + esc(d.name) + ' <span class="small muted mono">' + esc(d.ip || '') + '</span></b><div class="row">' + rolePill(s.role) + '<span class="conf">' + esc(C.confWord(s.confidence)) + '</span></div><p>' + esc(s.why) + '</p>' + (s.check ? '<p class="small"><b>Check on site:</b> ' + esc(s.check) + '</p>' : '') + (s.role !== 'unknown' ? '<div><button class="btn small" type="button" data-act="usesugg" data-id="' + esc(d.id) + '">Use this</button></div>' : '') + '</div>';
          }).join('') + '</div><div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>';
          loadMe();
        }).catch(function (err) { send.disabled = false; send.textContent = 'Ask AI'; meteredError(err, $('#idErr', root), function () { openIdentify(onlyId); }); });
      });
    });
  }

  /* ---------------- sheets and the account ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    document.body.classList.add('sheet-open');
    s.scrollTop = 0;
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2');
    if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Nothing in Zoned needs an account except "Help me identify", the one AI feature - a free account comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field" style="margin:10px 0"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field" style="margin:10px 0"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center" style="margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Identifying devices with AI costs about a cent. The findings, the plan, the letter and the report are free and need no account.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); });
        });
        var pk = $('#pkEnrol', root);
        if (pk) pk.addEventListener('click', function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        });
      });
  }
  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" type="button" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button><p class="small muted">Membership covers every app on this site, runs the better model and lets you add credit.</p>';
        $('#joinM', el).addEventListener('click', function () { checkout('api/auth/billing/membership', {}); });
        return;
      }
      el.innerHTML = '<div class="row">' + (b.topUps || []).map(function (t) { return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) { btn.addEventListener('click', function () { checkout('api/auth/billing/credit', { usd: Number(btn.getAttribute('data-usd')) }); }); });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The findings, the plan, the letter and the report keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-check')) {
      var id = t.getAttribute('data-check');
      if (t.checked) state.saved.checks[id] = 1; else delete state.saved.checks[id];
      saveSaved();
      var li = t.closest('li'); if (li) li.classList.toggle('done', t.checked);
      var head = t.closest('.card') && $('.sec-head .small', t.closest('.card'));
      if (head) head.textContent = $$('[data-check]').filter(function (x) { return x.checked; }).length + ' of ' + $$('[data-check]').length + ' done';
      return;
    }
    if (t.hasAttribute('data-map')) {
      var f = state.files[+t.getAttribute('data-i')];
      if (!f) return;
      var m = Object.assign({}, f.parsed.mapping || {});
      m[t.getAttribute('data-map')] = +t.value;
      f.mapping = m;
      f.parsed = C.readInput(f.text, f.name, { mapping: m });
      redrawFiles();
    }
  });
  document.addEventListener('toggle', function (e) {
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-find')) state.openFind[t.getAttribute('data-find')] = t.open;
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'example': history.pushState(null, '', BASE + '#example'); openDemo(true); break;
      case 'gocheck': go('check'); break;
      case 'tab': e.preventDefault(); closeSheet(true); go(t.getAttribute('data-tab')); break;
      case 'cos': state.cmd.os = t.getAttribute('data-v') === 'windows' ? 'windows' : 'unix'; keep(K_CMD, state.cmd); draw(); break;
      case 'cwhich': state.cmd.which = t.getAttribute('data-v'); keep(K_CMD, state.cmd); draw(); break;
      case 'copycmd': { var c = C.gatherCommands(state.cmd); if (c.error) toast(c.error); else copy(c[state.cmd.which].cmd, 'Command copied - run it on a computer at the store'); break; }
      case 'togglepaste': state.showPaste = !state.showPaste; draw(); if (state.showPaste) { var ta0 = $('#pasteText'); if (ta0) ta0.focus(); } break;
      case 'addpaste': { var ta = $('#pasteText'); if (ta && ta.value.trim()) { if (state.files.length >= C.LIMITS.files) { toast('Up to ' + C.LIMITS.files + ' files at once.'); break; } addText(ta.value, 'Pasted text ' + (state.files.length + 1)); ta.value = ''; redrawFiles(); } else toast('Paste some output first.'); break; }
      case 'rmfile': state.files.splice(+t.getAttribute('data-i'), 1); redrawFiles(); break;
      case 'clearfiles': state.files = []; redrawFiles(); break;
      case 'runcheck': openWith(false); state.view = 'dash'; state.tab = 'findings'; history.pushState(null, '', BASE + '#findings'); draw(); scrollTo(0, 0); break;
      case 'device': openDevice(t.getAttribute('data-id')); break;
      case 'resetrole': { var d0 = state.a.byId[t.getAttribute('data-id')]; if (d0) setRole(d0.id, d0.cls.auto.role); break; }
      case 'filter': state.filter = t.getAttribute('data-v'); drawTab(); break;
      case 'identify': openIdentify(t.getAttribute('data-id')); break;
      case 'signin-identify': openAccount('Identifying devices uses about a cent of AI credit; a free account comes with $2.', function () { openIdentify(); }); break;
      case 'usesugg': { var sid = t.getAttribute('data-id'), sg = state.suggestions[sid]; if (sg && ROLES[sg.role]) { var wasOpen = $('#sheet h2') && /identify/i.test($('#sheet h2').textContent); setRole(sid, sg.role); if (wasOpen) { t.disabled = true; t.textContent = 'Used'; } } break; }
      case 'gear': state.gear = t.getAttribute('data-v'); drawTab(); break;
      case 'copyrules': copy(rulesText(state.a.rules), 'Rules copied'); break;
      case 'copyletter': copy($('#letter') ? $('#letter').value : letterText(), 'Letter copied'); break;
      case 'dlletter': download('letter-to-contractor.txt', 'text/plain', $('#letter') ? $('#letter').value : letterText()); break;
      case 'rebuildletter': state.saved.letter = null; saveSaved(); drawTab(); break;
      case 'print': window.print(); break;
      case 'md': download(fname('.md'), 'text/markdown', C.toMarkdown(state.a, extras())); break;
      case 'json': download(fname('.json'), 'application/json', C.toJson(state.a, extras())); break;
      case 'copymd': copy(C.toMarkdown(state.a, extras()), 'Markdown copied'); break;
      case 'clearsaved': state.saved = blankSaved(); saveSaved(); analyseNow(); drawTab(); toast('Cleared from this browser'); break;
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  (function () {
    var c = recall(K_CMD);
    if (c && typeof c === 'object') {
      if (typeof c.cidr === 'string' && C.parseCidr(c.cidr)) state.cmd.cidr = c.cidr.slice(0, 20);
      if (c.os === 'windows' || c.os === 'unix') state.cmd.os = c.os;
      if (CMD_KINDS.some(function (k) { return k[0] === c.which; })) state.cmd.which = c.which;
    } else if (/Windows/.test(navigator.userAgent || '')) state.cmd.os = 'windows';
  }());
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
}());
