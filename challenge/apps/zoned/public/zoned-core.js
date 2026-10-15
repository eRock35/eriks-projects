/* Zoned - the rules. One file, run in two places: the page
 * (window.ZonedCore) and the server and tests (require).
 *
 * Everything that decides a finding lives here and is pure and
 * deterministic: the same files give the same devices, the same roles, the
 * same findings and the same zone plan, on every machine. Nothing here
 * touches the network or storage - and nothing here scans, pings or
 * connects to anything. It only reads text the user already has.
 *
 *   reading      readInput -> nmap XML (-oX, a small safe tokenizer: no
 *                DTD, no external or custom entities), nmap normal output
 *                (-oN / the terminal), nmap grepable (-oG), ARP tables
 *                (Windows, macOS/BSD, Linux arp and ip neigh), DHCP lease
 *                exports (CSV with a column mapping, dnsmasq leases)
 *   merging      merge -> one device per MAC (else per IP), sources kept
 *   roles        classify -> a role, a confidence and the evidence, from
 *                vendor names the scan tools resolved, ports, banners,
 *                hostnames and the operating-system guess
 *   findings     findings -> ranked, in words, with the devices
 *   the plan     zonePlan, firewallRules, STEPS, checklist, letter
 *   exports      toMarkdown, toJson
 *   the model    identifyPayload, cleanIdentifyRequest, cleanIdentification
 *
 * Hostnames, banners, vendor strings and page titles are written by whoever
 * controls the device - hostile: markup, bidi overrides, control characters,
 * very long strings. They are bounded by clean() when read, and only ever
 * drawn through esc(); every export escapes for its own format.
 *
 * MAC prefixes (OUIs) are deliberately NOT mapped to vendors here: the only
 * vendor names used are the ones nmap (or a DHCP export) already resolved.
 * The two MAC facts used are bits of the address itself, defined by IEEE 802:
 * the multicast bit and the locally-administered ("private address") bit.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZonedCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    bytes: 40 * 1024 * 1024,    // one input file
    files: 12,                  // inputs at once
    devices: 4096,              // devices kept after merging
    xmlElements: 2000000,       // elements read from one XML file
    xmlDepth: 64,
    portsPerDevice: 200,
    hostnames: 6,
    strLen: 300,                // a banner or title, after cleaning
    nameLen: 120,               // a hostname or vendor
    csvRows: 20000,
    noteLen: 500,
    identifyDevices: 12,        // devices sent to "Help me identify"
    identifyServices: 20,       // services per device sent
    identifyStr: 160,           // characters per string sent
  };

  /* ---------------- text ---------------- */

  var CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/g;
  /** A string safe to show: control, bidi and zero-width characters removed,
   *  whitespace folded, bounded. */
  function clean(v, max) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(/[\t\r\n]+/g, ' ').replace(CTRL, '').replace(/ {2,}/g, ' ').trim();
    var m = max || LIMITS.strLen;
    return s.length > m ? s.slice(0, m - 1) + '…' : s;
  }
  /** HTML-escape, and drop control, bidi and zero-width characters. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(CTRL, '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's')); }
  function words(n) { return n >= 0 && n <= 10 ? ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] : fmtInt(n); }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /** "a, b and c" */
  function andList(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  /** A short, stable fingerprint of a text (two FNV-1a passes, hex). Keys
   *  this browser's overrides to one set of inputs - never sent. */
  function hashText(s) {
    s = String(s || '');
    var a = 2166136261, b = 5381;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      a ^= c; a = Math.imul(a, 16777619) >>> 0;
      b = (Math.imul(b, 33) + c) >>> 0;
    }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8) + '-' + s.length.toString(36);
  }
  function uniq(a) { var s = Object.create(null), out = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; out.push(x); } }); return out; }
  /** A Markdown code span that survives backticks and pipes. */
  function mdCode(s) {
    var t = String(s === null || s === undefined ? '' : s).replace(CTRL, '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
    var ticks = 1; while (t.indexOf(new Array(ticks + 1).join('`')) !== -1) ticks++;
    var f = new Array(ticks + 1).join('`');
    return f + (ticks > 1 || /^`|`$/.test(t) ? ' ' + t + ' ' : t) + f;
  }
  /** Prose for Markdown: no markup, no links, no headings from a name. */
  function mdText(s) {
    return String(s === null || s === undefined ? '' : s).replace(CTRL, '').replace(/[\r\n]+/g, ' ')
      .replace(/[\\`*_{}[\]()#+!|>~]/g, '\\$&').replace(/</g, '&lt;').replace(/^(\s*)([-=])/, '$1\\$2').replace(/^(\s*\d+)\./, '$1\\.');
  }

  /* ---------------- addresses ---------------- */

  var IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  function isIPv4(s) { return IPV4.test(String(s || '')); }
  function ipNum(ip) { var p = String(ip).split('.'); return ((+p[0] * 256 + +p[1]) * 256 + +p[2]) * 256 + +p[3]; }
  function ipStr(n) { return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.'); }
  /** A MAC in any common spelling -> "00:1a:2b:3c:4d:5e", or '' when it is not
   *  one. Takes 00-1A-..., 001A.2B3C.4D5E (Cisco), 001a2b3c4d5e (Windows DHCP),
   *  0:1a:2b:3:4d:5e (macOS drops leading zeros), and a Windows DHCP client id
   *  of 01 + the MAC. */
  function normMac(v) {
    var s = String(v || '').trim().toLowerCase();
    var parts = s.split(/[:-]/);
    if (parts.length === 6 && parts.every(function (p) { return /^[0-9a-f]{1,2}$/.test(p); })) return parts.map(function (p) { return p.length === 1 ? '0' + p : p; }).join(':');
    var hex = s.replace(/[.:\-\s]/g, '');
    if (/^01[0-9a-f]{12}$/.test(hex) && s.indexOf('-') !== -1 && s.split('-').length === 7) hex = hex.slice(2);
    if (!/^[0-9a-f]{12}$/.test(hex)) return '';
    return hex.match(/../g).join(':');
  }
  function macFirst(mac) { return parseInt(String(mac).slice(0, 2), 16); }
  /** IEEE 802: the lowest bit of the first octet marks a group (multicast or
   *  broadcast) address - never a device. */
  function multicastMac(mac) { return Boolean(mac) && (macFirst(mac) & 1) === 1; }
  /** IEEE 802: the second-lowest bit marks a locally administered address -
   *  what phones and laptops use as a "private Wi-Fi address". */
  function randomMac(mac) { return Boolean(mac) && !multicastMac(mac) && (macFirst(mac) & 2) === 2; }
  function parseCidr(s) {
    var m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\s*$/.exec(String(s || ''));
    if (!m || !isIPv4(m[1]) || +m[2] > 32) return null;
    var bits = +m[2], mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    var net = (ipNum(m[1]) & mask) >>> 0;
    return { cidr: ipStr(net) + '/' + bits, net: net, bits: bits, mask: mask };
  }
  function inCidr(ip, c) { return ((ipNum(ip) & c.mask) >>> 0) === c.net; }

  /* ---------------- roles and zones ---------------- */

  var ROLES = {
    pos: { label: 'Payment / POS', short: 'Payments', icon: '💳', zone: 'payments', ot: false },
    office: { label: 'Office PC or server', short: 'Office', icon: '🖥️', zone: 'office', ot: false },
    printer: { label: 'Printer', short: 'Printer', icon: '🖨️', zone: 'office', ot: false },
    camera: { label: 'Camera or recorder (NVR)', short: 'Camera', icon: '📹', zone: 'cameras', ot: false },
    network: { label: 'Network gear', short: 'Network', icon: '🌐', zone: 'mgmt', ot: false },
    guest: { label: 'Guest or personal device', short: 'Guest', icon: '📱', zone: 'guest', ot: false },
    refrigeration: { label: 'Refrigeration controller', short: 'Refrigeration', icon: '❄️', zone: 'ot', ot: true },
    hvac: { label: 'HVAC / building controller', short: 'HVAC', icon: '🌡️', zone: 'ot', ot: true },
    bms: { label: 'Building management workstation', short: 'BMS PC', icon: '🏢', zone: 'ot', ot: true },
    lighting: { label: 'Lighting / energy controller', short: 'Lighting', icon: '💡', zone: 'ot', ot: true },
    remote: { label: 'Remote-access gateway', short: 'Remote access', icon: '📡', zone: 'ot', ot: true },
    iot: { label: 'Smart / IoT device', short: 'IoT', icon: '🔌', zone: 'ot', ot: true },
    unknown: { label: 'Not identified yet', short: 'Unknown', icon: '❓', zone: 'guest', ot: false },
  };
  var ROLE_KEYS = Object.keys(ROLES);
  var CONTROLLERS = ['refrigeration', 'hvac', 'lighting'];

  /** Zones in the order a plan lists them. Subnets are suggested in a block
   *  that cannot clash with the network being replaced (subnetScheme). */
  var ZONES = {
    payments: { name: 'Payments', vlan: 20, icon: '💳', purpose: 'Tills and card readers. Talks to the card processor and nothing else.' },
    office: { name: 'Office', vlan: 10, icon: '🖥️', purpose: 'Staff PCs, the NAS and printers. Web and email - the usual way in - so it reaches nothing it does not need.' },
    ot: { name: 'Building & OT', vlan: 30, icon: '🏭', purpose: 'Refrigeration, HVAC and lighting controllers, the building-management PC and smart building devices. Reached by the BMS PC and the contractor through your VPN only.' },
    cameras: { name: 'Cameras', vlan: 40, icon: '📹', purpose: 'Cameras and the recorder. Cameras talk to the recorder; one office PC views it.' },
    guest: { name: 'Guest', vlan: 50, icon: '📶', purpose: 'Guest and staff phones, and anything not identified yet. Internet only, each device isolated from the others.' },
    mgmt: { name: 'Management', vlan: 99, icon: '🌐', purpose: 'The switches, access points and firewall admin pages. Reached from one admin PC only.' },
  };
  var ZONE_ORDER = ['payments', 'office', 'ot', 'cameras', 'guest', 'mgmt'];

  var SEVERITY = {
    high: { word: 'High', icon: '▲', rank: 3 },
    medium: { word: 'Medium', icon: '◆', rank: 2 },
    low: { word: 'Low', icon: '●', rank: 1 },
    info: { word: 'Note', icon: '○', rank: 0 },
  };
  var CONF = { high: 'Sure', medium: 'Likely', low: 'A guess', you: 'Set by you' };

  /* Well-known ports, with what they mean in words. */
  var PORTS = {
    '21/tcp': 'FTP (plain-text file transfer)', '22/tcp': 'SSH', '23/tcp': 'Telnet (plain-text login)', '53/tcp': 'DNS', '53/udp': 'DNS',
    '80/tcp': 'HTTP web page', '102/tcp': 'Siemens S7', '135/tcp': 'Windows RPC', '139/tcp': 'Windows file sharing', '161/udp': 'SNMP',
    '443/tcp': 'HTTPS web page', '445/tcp': 'Windows file sharing (SMB)', '502/tcp': 'Modbus TCP', '515/tcp': 'LPD printing', '554/tcp': 'RTSP video',
    '631/tcp': 'IPP printing', '1628/tcp': 'LonWorks/IP', '1628/udp': 'LonWorks/IP', '1629/tcp': 'LonWorks/IP', '1629/udp': 'LonWorks/IP',
    '1883/tcp': 'MQTT', '1911/tcp': 'Niagara Fox', '3389/tcp': 'Remote Desktop (RDP)', '3671/udp': 'KNX/IP', '4911/tcp': 'Niagara Fox (TLS)',
    '5000/tcp': 'Web admin (alt)', '5001/tcp': 'Web admin (alt, TLS)', '5900/tcp': 'VNC remote control', '5901/tcp': 'VNC remote control', '5902/tcp': 'VNC remote control', '5903/tcp': 'VNC remote control',
    '5938/tcp': 'TeamViewer', '8000/tcp': 'HTTP web page (alt)', '8080/tcp': 'HTTP web page (alt)', '8443/tcp': 'HTTPS web page (alt)', '8883/tcp': 'MQTT over TLS',
    '9100/tcp': 'Raw printing (JetDirect)', '9443/tcp': 'HTTPS web page (alt)', '20000/tcp': 'DNP3', '37777/tcp': 'Dahua video', '44818/tcp': 'EtherNet/IP',
    '47808/udp': 'BACnet/IP', '47808/tcp': 'BACnet/IP',
  };
  function portLabel(p) { return PORTS[p.port + '/' + p.proto] || (p.service ? p.service : 'port ' + p.port); }
  /** Building and industrial protocols that carry no password of their own. */
  var OT_PORTS = { '47808/udp': 'BACnet/IP', '47808/tcp': 'BACnet/IP', '502/tcp': 'Modbus TCP', '1911/tcp': 'Niagara Fox', '1628/udp': 'LonWorks/IP', '1629/udp': 'LonWorks/IP', '1628/tcp': 'LonWorks/IP', '1629/tcp': 'LonWorks/IP', '3671/udp': 'KNX/IP', '20000/tcp': 'DNP3', '102/tcp': 'Siemens S7', '44818/tcp': 'EtherNet/IP' };
  var REMOTE_PORTS = { '3389/tcp': 'Remote Desktop', '5900/tcp': 'VNC', '5901/tcp': 'VNC', '5902/tcp': 'VNC', '5903/tcp': 'VNC', '5938/tcp': 'TeamViewer' };
  var CLEAR_PORTS = { '23/tcp': 'Telnet', '21/tcp': 'FTP' };
  var HTTP_PORTS = { 80: 1, 8000: 1, 8080: 1 };
  var HTTPS_PORTS = { 443: 1, 8443: 1, 9443: 1, 5001: 1, 4911: 1 };

  /* ---------------- the commands (the user runs them; Zoned never does) ---------------- */

  var TCP_PORTS = '1-1024,1883,1911,3389,4911,5900,5938,8000,8080,8443,8883,9100,9443,20000,37777,44818,47808';
  var UDP_PORTS = '47808,1628,1629,3671';
  var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
  /** The exact commands, for a network the user names. Only a CIDR between
   *  /16 and /32 and a plain file name get in, so nothing typed can change
   *  what runs. */
  function gatherCommands(opts) {
    var o = opts || {};
    var c = parseCidr(o.cidr);
    if (!c) return { error: 'Type the network as an address and size, like 192.168.1.0/24.' };
    if (c.bits < 16) return { error: 'That is a very large network (more than 65,536 addresses). Scan one store network at a time, like 192.168.1.0/24.' };
    var name = String(o.name || 'store');
    if (!NAME_RE.test(name)) return { error: 'Use letters, numbers, - or _ for the file name.' };
    var win = o.os === 'windows';
    var su = win ? '' : 'sudo ';
    var net = c.cidr;
    return {
      cidr: net,
      full: { cmd: su + 'nmap -sV -O --max-rate 200 -p T:' + TCP_PORTS + ' -oX ' + name + '.xml ' + net, file: name + '.xml' },
      quick: { cmd: su + 'nmap -sn -oX ' + name + '-hosts.xml ' + net, file: name + '-hosts.xml' },
      udp: { cmd: su + 'nmap -sU -sV --max-rate 100 -p U:' + UDP_PORTS + ' -oX ' + name + '-udp.xml ' + net, file: name + '-udp.xml' },
      arp: win ? { cmd: 'arp -a > arp.txt', file: 'arp.txt' } : { cmd: 'arp -a > arp.txt', alt: 'ip neigh > arp.txt', file: 'arp.txt' },
      dhcp: { cmd: 'Get-DhcpServerv4Lease -ScopeId ' + ipStr(c.net) + ' | Select-Object IPAddress,ClientId,HostName | Export-Csv leases.csv -NoTypeInformation', file: 'leases.csv' },
      shell: win ? 'windows' : 'unix',
    };
  }

  /* ---------------- XML: a small tokenizer that cannot fetch or expand ---------------- */

  /** Decode only XML's five named entities and numeric references. A custom
   *  entity (declared in a DTD, internal or external) is left as its literal
   *  text and counted: nothing is ever expanded, fetched or read. */
  function decodeXml(s, st) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z_][\w.-]{0,40});/g, function (all, e) {
      if (e.charAt(0) === '#') {
        var n = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!(n > 0) || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
        return String.fromCodePoint ? String.fromCodePoint(n) : String.fromCharCode(n);
      }
      var k = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
      if (k) return k;
      if (st) st.unknownEntities++;
      return all;
    });
  }
  /** Walk an XML document: h.open(name, attrs), h.close(name). Comments,
   *  processing instructions and the DOCTYPE (with any internal subset) are
   *  skipped; CDATA and text are ignored (nmap keeps what we need in
   *  attributes). Returns stats: elements, doctype, declared entities, custom
   *  entity references left unexpanded, malformed bits, truncated. */
  function xmlWalk(text, h) {
    var s = String(text), n = s.length, i = 0;
    var st = { elements: 0, doctype: false, declaredEntities: 0, unknownEntities: 0, malformed: 0, truncated: false, depth: 0, tooDeep: false, stopped: false };
    if (s.charCodeAt(0) === 0xFEFF) i = 1;
    var stack = [];
    while (i < n) {
      var lt = s.indexOf('<', i);
      if (lt === -1) break;
      if (s.substr(lt, 4) === '<!--') { var e1 = s.indexOf('-->', lt + 4); if (e1 === -1) { st.truncated = true; break; } i = e1 + 3; continue; }
      if (s.substr(lt, 9) === '<![CDATA[') { var e2 = s.indexOf(']]>', lt + 9); if (e2 === -1) { st.truncated = true; break; } i = e2 + 3; continue; }
      if (s.substr(lt, 2) === '<?') { var e3 = s.indexOf('?>', lt + 2); if (e3 === -1) { st.truncated = true; break; } i = e3 + 2; continue; }
      if (s.substr(lt, 2) === '<!') {
        st.doctype = true;
        var gt = s.indexOf('>', lt), br = s.indexOf('[', lt);
        if (br !== -1 && (gt === -1 || br < gt)) {
          var endSub = s.indexOf(']', br);
          var sub = endSub === -1 ? s.slice(br) : s.slice(br, endSub);
          st.declaredEntities += (sub.match(/<!ENTITY/gi) || []).length;
          gt = endSub === -1 ? -1 : s.indexOf('>', endSub);
        }
        if (gt === -1) { st.truncated = true; break; }
        i = gt + 1; continue;
      }
      if (s.charAt(lt + 1) === '/') {
        var ge = s.indexOf('>', lt);
        if (ge === -1) { st.truncated = true; break; }
        var cname = s.slice(lt + 2, ge).trim();
        var at = stack.lastIndexOf(cname);
        if (at === -1) st.malformed++;
        else { while (stack.length > at) { var top = stack.pop(); if (top !== cname) st.malformed++; h.close(top); } }
        i = ge + 1; continue;
      }
      // A start tag: find its '>' outside quotes.
      var j = lt + 1, q = '';
      for (; j < n; j++) {
        var ch = s.charAt(j);
        if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; else if (ch === '<') break;
      }
      if (j >= n) { st.truncated = true; break; }
      if (s.charAt(j) === '<') { st.malformed++; i = j; continue; }
      var body = s.slice(lt + 1, j);
      var self = body.charAt(body.length - 1) === '/';
      if (self) body = body.slice(0, -1);
      var m = /^([A-Za-z_][\w:.-]*)/.exec(body);
      if (!m) { st.malformed++; i = j + 1; continue; }
      if (++st.elements > LIMITS.xmlElements) { st.stopped = true; break; }
      var attrs = {}, re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g, am;
      var rest = body.slice(m[1].length);
      while ((am = re.exec(rest))) { var key = am[1]; if (!Object.prototype.hasOwnProperty.call(attrs, key)) attrs[key] = decodeXml(am[3] !== undefined ? am[3] : am[4], st); }
      if (!self && stack.length >= LIMITS.xmlDepth) { st.tooDeep = true; st.malformed++; i = j + 1; continue; }
      h.open(m[1], attrs);
      if (self) h.close(m[1]); else stack.push(m[1]);
      i = j + 1;
    }
    if (stack.length && !st.stopped) st.truncated = true;
    st.open = stack.slice();
    return st;
  }

  /* ---------------- a parsed input ---------------- */

  function blankDevice() { return { ip: '', ipv6: [], mac: '', vendor: '', hostnames: [], ports: [], os: null, devicetype: '', sources: [] }; }
  function addHostname(d, name) {
    var h = clean(name, LIMITS.nameLen);
    if (!h || h === '*' || h === '?' || isIPv4(h)) return;
    if (d.hostnames.indexOf(h) === -1 && d.hostnames.length < LIMITS.hostnames) d.hostnames.push(h);
  }
  function setVendor(d, v) {
    var c = clean(v, LIMITS.nameLen);
    if (!c || /^unknown$/i.test(c)) return;
    if (!d.vendor) d.vendor = c;
  }
  function addPort(d, p) {
    if (!(p.port > 0 && p.port < 65536)) return;
    var proto = /^(tcp|udp|sctp)$/.test(p.proto) ? p.proto : 'tcp';
    var key = p.port + '/' + proto;
    var old = null;
    for (var k = 0; k < d.ports.length; k++) if (d.ports[k].port + '/' + d.ports[k].proto === key) old = d.ports[k];
    var n = {
      port: p.port, proto: proto, state: clean(p.state, 30) || 'open',
      service: clean(p.service, 60), product: clean(p.product, LIMITS.nameLen), version: clean(p.version, 80),
      extrainfo: clean(p.extrainfo, 160), title: clean(p.title, LIMITS.strLen), banner: clean(p.banner, LIMITS.strLen),
    };
    if (old) { Object.keys(n).forEach(function (f) { if (!old[f] && n[f]) old[f] = n[f]; }); if (n.state === 'open') old.state = 'open'; return; }
    if (d.ports.length < LIMITS.portsPerDevice) d.ports.push(n);
  }
  function openPorts(d) { return d.ports.filter(function (p) { return p.state === 'open'; }); }

  /** nmap XML (-oX). Hosts that are down are counted and skipped. */
  function parseNmapXml(text) {
    var out = { kind: 'nmap-xml', label: 'nmap XML', devices: [], notes: [], cidrs: [], down: 0, args: '' };
    var cur = null, port = null, inOs = null, bestAcc = -1, inHost = false;
    var st = xmlWalk(text, {
      open: function (name, a) {
        if (name === 'nmaprun') { out.args = clean(a.args, 400); out.version = clean(a.version, 20); return; }
        if (name === 'host') { cur = blankDevice(); cur.status = ''; bestAcc = -1; inHost = true; return; }
        if (!cur) return;
        if (name === 'status') cur.status = clean(a.state, 20);
        else if (name === 'address') {
          if (a.addrtype === 'ipv4' && isIPv4(a.addr)) { if (!cur.ip) cur.ip = a.addr; }
          else if (a.addrtype === 'ipv6') { var v6 = clean(a.addr, 45); if (v6 && cur.ipv6.length < 4) cur.ipv6.push(v6); }
          else if (a.addrtype === 'mac') { cur.mac = normMac(a.addr); if (a.vendor) setVendor(cur, a.vendor); }
        } else if (name === 'hostname') addHostname(cur, a.name);
        else if (name === 'port') port = { port: parseInt(a.portid, 10), proto: a.protocol, state: '' };
        else if (name === 'state' && port) port.state = a.state;
        else if (name === 'service' && port) { port.service = a.name; port.product = a.product; port.version = a.version; port.extrainfo = a.extrainfo; if (a.devicetype && !cur.devicetype) cur.devicetype = clean(a.devicetype, 40); }
        else if (name === 'script' && port) {
          if (a.id === 'http-title') port.title = a.output;
          else if (a.id === 'banner' || a.id === 'bacnet-info' || a.id === 'fox-info' || a.id === 'modbus-discover' || a.id === 'http-server-header') port.banner = (port.banner ? port.banner + ' ' : '') + a.output;
        } else if (name === 'osmatch') {
          var acc = parseInt(a.accuracy, 10) || 0;
          if (acc > bestAcc) { bestAcc = acc; cur.os = { name: clean(a.name, 120), accuracy: acc, type: '', vendor: '', family: '' }; inOs = cur.os; } else inOs = null;
        } else if (name === 'osclass' && inOs && !inOs.type) { inOs.type = clean(a.type, 40); inOs.vendor = clean(a.vendor, 60); inOs.family = clean(a.osfamily, 60); }
      },
      close: function (name) {
        if (name === 'port' && cur && port) { addPort(cur, port); port = null; }
        else if (name === 'osmatch') inOs = null;
        else if (name === 'host' && cur) { finishHost(cur); cur = null; inHost = false; }
      },
    });
    function finishHost(h) {
      if (h.status === 'down') { out.down++; return; }
      if (!h.ip && !h.mac) return;
      delete h.status;
      h.sources = ['nmap-xml'];
      if (out.devices.length < LIMITS.devices) out.devices.push(h);
    }
    if (inHost && cur && (cur.ip || cur.mac)) { finishHost(cur); out.notes.push('The file ends in the middle of a host - the scan may still have been running when it was saved. The last host was read as far as it goes.'); }
    else if (st.truncated) out.notes.push('The file ends early - it may have been cut off. Everything before that was read.');
    if (st.declaredEntities || st.unknownEntities) out.notes.push('The file declares its own XML entities. Zoned never expands or fetches them: ' + plural(st.unknownEntities, 'reference was', 'references were') + ' left as plain text.');
    if (st.malformed) out.notes.push(plural(st.malformed, 'part', 'parts') + ' of the XML could not be read and ' + (st.malformed === 1 ? 'was' : 'were') + ' skipped.');
    if (st.stopped) out.notes.push('The file is very large: only the first ' + fmtInt(LIMITS.xmlElements) + ' XML elements were read.');
    out.cidrs = cidrsIn(out.args);
    out.stats = st;
    if (!out.devices.length && !out.down && !/nmaprun/.test(String(text).slice(0, 4000))) out.notes.push('This does not look like nmap XML.');
    return out;
  }
  function cidrsIn(args) {
    var out = [], re = /(?:^|[\s,])(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})(?=$|[\s,])/g, m;
    while ((m = re.exec(String(args || '')))) { var c = parseCidr(m[1]); if (c && c.bits >= 8) out.push(c.cidr); }
    return uniq(out);
  }

  /** nmap's normal output (-oN, or what the terminal shows). */
  function parseNmapNormal(text) {
    var out = { kind: 'nmap-normal', label: 'nmap output', devices: [], notes: [], cidrs: [], down: 0, args: '' };
    var cur = null, lastPort = null;
    var lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
    function done() { if (cur && (cur.ip || cur.mac)) { cur.sources = ['nmap-normal']; if (out.devices.length < LIMITS.devices) out.devices.push(cur); } cur = null; lastPort = null; }
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      var m;
      if ((m = /^# Nmap .* as: (.*)$/.exec(line)) || (m = /^Starting Nmap.*$/.exec(line))) { if (m[1]) out.args = clean(m[1], 400); return; }
      if ((m = /^Nmap scan report for (.+?)(?: \((\d{1,3}(?:\.\d{1,3}){3})\))?$/.exec(line))) {
        done();
        cur = blankDevice();
        if (m[2]) { cur.ip = m[2]; addHostname(cur, m[1]); } else if (isIPv4(m[1])) cur.ip = m[1]; else addHostname(cur, m[1]);
        return;
      }
      if (!cur) return;
      if ((m = /^(\d{1,5})\/(tcp|udp|sctp)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line))) {
        lastPort = { port: +m[1], proto: m[2], state: m[3], service: m[4].replace(/\?$/, ''), product: m[5] || '' };
        addPort(cur, lastPort);
        lastPort = cur.ports[cur.ports.length - 1];
        return;
      }
      if ((m = /^\|[_ ]?\s*http-title:\s*(.*)$/.exec(line)) && lastPort) { if (!lastPort.title) lastPort.title = clean(m[1], LIMITS.strLen); return; }
      if ((m = /^MAC Address: ([0-9A-Fa-f:]{11,17})(?: \((.*)\))?$/.exec(line))) { cur.mac = normMac(m[1]); setVendor(cur, m[2]); return; }
      if ((m = /^Device type: (.*)$/.exec(line))) { cur.devicetype = clean(m[1].split('|')[0], 40); return; }
      if ((m = /^(?:OS details|Running(?: \(JUST GUESSING\))?): (.*)$/.exec(line))) { if (!cur.os) cur.os = { name: clean(m[1], 120), accuracy: /GUESSING/.test(line) ? 80 : 95, type: cur.devicetype || '', vendor: '', family: '' }; return; }
      if (/^Host seems down/.test(line)) { out.down++; cur = null; }
    });
    done();
    out.cidrs = cidrsIn(out.args);
    return out;
  }

  /** nmap grepable (-oG). It carries no MAC address or vendor - nmap leaves
   *  them out of this format - so the page suggests adding an ARP table. */
  function parseGrepable(text) {
    var out = { kind: 'nmap-grepable', label: 'nmap grepable', devices: [], notes: [], cidrs: [], down: 0, args: '' };
    var by = Object.create(null);
    String(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach(function (line) {
      var m;
      if ((m = /^# Nmap .* as: (.*)$/.exec(line))) { out.args = clean(m[1], 400); return; }
      if (!(m = /^Host: (\d{1,3}(?:\.\d{1,3}){3}) \(([^)]*)\)\t(.*)$/.exec(line)) || !isIPv4(m[1])) return;
      var ip = m[1];
      var fields = m[3].split('\t');
      var status = '';
      fields.forEach(function (f) { var s = /^Status: (\w+)/.exec(f); if (s) status = s[1]; });
      if (status === 'Down') { out.down++; return; }
      var d = by[ip];
      if (!d) { d = by[ip] = blankDevice(); d.ip = ip; d.sources = ['nmap-grepable']; }
      addHostname(d, m[2]);
      fields.forEach(function (f) {
        var p = /^Ports: (.*)$/.exec(f);
        if (p) {
          var re = /(\d{1,5})\/([a-z|]+)\/(tcp|udp|sctp)\/([^/]*)\/([^/]*)\/([^/]*)\/([^/]*)\//g, pm;
          while ((pm = re.exec(p[1]))) addPort(d, { port: +pm[1], state: pm[2], proto: pm[3], service: pm[5], product: pm[7].replace(/\|/g, '/') });
        }
        var o = /^OS: (.*)$/.exec(f);
        if (o) d.os = { name: clean(o[1], 120), accuracy: 90, type: '', vendor: '', family: '' };
      });
    });
    Object.keys(by).forEach(function (k) { if (out.devices.length < LIMITS.devices) out.devices.push(by[k]); });
    out.cidrs = cidrsIn(out.args);
    if (out.devices.length) out.notes.push('Grepable output has no MAC addresses or vendor names. Add an ARP table, or scan with -oX, for better identification.');
    return out;
  }

  /** ARP tables: Windows `arp -a`, macOS/BSD `arp -a`, Linux `arp -a`,
   *  `arp -n` and `ip neigh`. Broadcast, multicast and incomplete entries
   *  are skipped. ARP knows addresses only - no vendor names. */
  function parseArp(text) {
    var out = { kind: 'arp', label: 'ARP table', devices: [], notes: [], cidrs: [], down: 0, format: '' };
    var seen = Object.create(null), skipped = 0;
    var formats = {};
    String(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach(function (line) {
      var m, ip = '', mac = '', name = '';
      if ((m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})\s+\S+\s*$/.exec(line))) { ip = m[1]; mac = m[2]; formats.Windows = 1; }
      else if ((m = /^(\S+) \((\d{1,3}(?:\.\d{1,3}){3})\) at ([0-9a-fA-F]{1,2}(?::[0-9a-fA-F]{1,2}){5})\b/.exec(line))) { ip = m[2]; mac = m[3]; name = m[1]; formats[/\bon \S+ (?:ifscope|\[ethernet\]|\[)/.test(line) && !/\[ether\]/.test(line) ? 'macOS' : 'Linux'] = 1; }
      else if ((m = /^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+\S+\s+lladdr\s+([0-9a-fA-F:]{17})\b/.exec(line))) { ip = m[1]; mac = m[2]; formats['Linux ip neigh'] = 1; }
      else if ((m = /^(\d{1,3}(?:\.\d{1,3}){3})\s+ether\s+([0-9a-fA-F:]{17})\b/.exec(line))) { ip = m[1]; mac = m[2]; formats['Linux arp -n'] = 1; }
      else { if (/incomplete|FAILED|INCOMPLETE/.test(line)) skipped++; return; }
      if (!isIPv4(ip)) return;
      var nm = normMac(mac);
      var first = +ip.split('.')[0];
      if (!nm || multicastMac(nm) || nm === '00:00:00:00:00:00' || (first >= 224 && first <= 239) || /\.255$/.test(ip)) { skipped++; return; }
      var key = nm + '|' + ip;
      if (seen[key]) return;
      seen[key] = 1;
      var d = blankDevice();
      d.ip = ip; d.mac = nm; d.sources = ['arp'];
      if (name && name !== '?') addHostname(d, name);
      if (out.devices.length < LIMITS.devices) out.devices.push(d);
    });
    out.format = Object.keys(formats).join(', ');
    if (skipped) out.notes.push(plural(skipped, 'entry', 'entries') + ' skipped: broadcast, multicast or not answering.');
    if (out.devices.length) out.notes.push('An ARP table lists only devices this computer talked to recently, and carries no vendor names.');
    return out;
  }

  /* ---- CSV ---- */

  /** RFC 4180-ish: quotes, doubled quotes, newlines in quotes, comma,
   *  semicolon or tab, a BOM, CRLF. Bounded rows. */
  function parseCsv(text) {
    var s = String(text).replace(/^\uFEFF/, '');
    var head = s.slice(0, s.indexOf('\n') === -1 ? s.length : s.indexOf('\n'));
    var counts = { ',': (head.match(/,/g) || []).length, ';': (head.match(/;/g) || []).length, '\t': (head.match(/\t/g) || []).length };
    var del = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    var rows = [], row = [], f = '', q = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) {
        if (c === '"') { if (s.charAt(i + 1) === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"' && f === '') q = true;
      else if (c === del) { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s.charAt(i + 1) === '\n') i++;
        row.push(f); f = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
        if (rows.length > LIMITS.csvRows) break;
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); if (row.length > 1 || row[0] !== '') rows.push(row); }
    return { rows: rows.slice(0, LIMITS.csvRows + 1), delimiter: del };
  }
  var COLS = {
    ip: /^(ip|ips|ip ?addr(ess)?|ipv4( ?addr(ess)?)?|address|client ip( ?address)?|leased ip|lease ip|fixed ip|ip address \(v4\)|current ip)$/,
    mac: /(^|\s)(mac|mac ?addr(ess)?|hw ?addr(ess)?|hardware( ?addr(ess)?)?|unique ?id|client ?id|physical( ?addr(ess)?)?|ethernet( ?addr(ess)?)?|chaddr|station)($|\s)/,
    hostname: /(^|\s)(host ?name|hostname|client ?name|device ?name|name|computer( ?name)?|client|device|alias|description)($|\s)/,
    vendor: /(^|\s)(vendor|manufacturer|oui|maker|brand)($|\s)/,
  };
  function headKey(h) { return clean(h, 80).toLowerCase().replace(/[^a-z0-9()]+/g, ' ').trim(); }
  /** Which column is which, from the header names first and the values to
   *  confirm (and to find columns a header did not name). */
  function automapLeases(rows) {
    var head = (rows[0] || []).map(headKey), body = rows.slice(1, 201);
    var share = function (col, test) { var n = 0, t = 0; body.forEach(function (r) { var v = (r[col] || '').trim(); if (v) { t++; if (test(v)) n++; } }); return t ? n / t : 0; };
    var map = { ip: -1, mac: -1, hostname: -1, vendor: -1 };
    ['ip', 'mac', 'vendor', 'hostname'].forEach(function (k) {
      for (var c = 0; c < head.length; c++) {
        if (map.ip === c || map.mac === c || map.vendor === c || map.hostname === c) continue;
        if (COLS[k].test(head[c])) {
          if (k === 'ip' && share(c, isIPv4) < 0.5) continue;
          if (k === 'mac' && share(c, function (v) { return Boolean(normMac(v)); }) < 0.5) continue;
          map[k] = c; break;
        }
      }
    });
    // Values when the header did not say (or there was no header).
    for (var c2 = 0; c2 < head.length; c2++) {
      if (map.ip === -1 && share(c2, isIPv4) >= 0.8 && c2 !== map.mac) map.ip = c2;
      if (map.mac === -1 && share(c2, function (v) { return Boolean(normMac(v)); }) >= 0.8 && c2 !== map.ip) map.mac = c2;
    }
    var headerless = rows[0] && (rows[0].some(function (v) { return isIPv4((v || '').trim()); }) || rows[0].some(function (v) { return Boolean(normMac(v)); }));
    return { map: map, headerless: Boolean(headerless) };
  }
  /** A DHCP lease export, CSV with any headers. `mapping` (from the page's
   *  column picker) wins over the automatic one. */
  function parseLeases(text, mapping) {
    var out = { kind: 'dhcp-csv', label: 'DHCP leases', devices: [], notes: [], cidrs: [], down: 0, columns: [], mapping: null };
    var csv = parseCsv(text);
    var rows = csv.rows;
    if (!rows.length) { out.notes.push('The file is empty.'); return out; }
    var auto = automapLeases(rows);
    var map = { ip: auto.map.ip, mac: auto.map.mac, hostname: auto.map.hostname, vendor: auto.map.vendor };
    if (mapping && typeof mapping === 'object') ['ip', 'mac', 'hostname', 'vendor'].forEach(function (k) { if (Number.isInteger(mapping[k]) && mapping[k] >= -1 && mapping[k] < (rows[0] || []).length) map[k] = mapping[k]; });
    out.columns = (rows[0] || []).map(function (h, i) { return auto.headerless ? 'Column ' + (i + 1) : (clean(h, 60) || 'Column ' + (i + 1)); });
    out.mapping = map;
    var start = auto.headerless ? 0 : 1;
    var skipped = 0;
    for (var r = start; r < rows.length; r++) {
      var row = rows[r];
      var ip = map.ip >= 0 ? (row[map.ip] || '').trim() : '';
      var mac = map.mac >= 0 ? normMac(row[map.mac]) : '';
      if (!isIPv4(ip)) ip = '';
      if (!ip && !mac) { skipped++; continue; }
      if (mac && multicastMac(mac)) { skipped++; continue; }
      var d = blankDevice();
      d.ip = ip; d.mac = mac; d.sources = ['dhcp'];
      if (map.hostname >= 0) addHostname(d, row[map.hostname]);
      if (map.vendor >= 0) setVendor(d, row[map.vendor]);
      if (out.devices.length < LIMITS.devices) out.devices.push(d);
    }
    if (map.ip === -1 && map.mac === -1) out.notes.push('No column of IP or MAC addresses was found. Pick the columns below.');
    else if (skipped) out.notes.push(plural(skipped, 'row', 'rows') + ' had no usable IP or MAC address and ' + (skipped === 1 ? 'was' : 'were') + ' skipped.');
    return out;
  }
  /** dnsmasq's lease file: "<expiry> <mac> <ip> <hostname> <client-id>". */
  function parseDnsmasq(text) {
    var out = { kind: 'dhcp-dnsmasq', label: 'DHCP leases (dnsmasq)', devices: [], notes: [], cidrs: [], down: 0 };
    String(text).split(/\r?\n/).forEach(function (line) {
      var m = /^\d{6,}\s+([0-9a-fA-F:]{17})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\S+)/.exec(line);
      if (!m || !isIPv4(m[2])) return;
      var d = blankDevice();
      d.mac = normMac(m[1]); d.ip = m[2]; d.sources = ['dhcp'];
      addHostname(d, m[3]);
      if (out.devices.length < LIMITS.devices) out.devices.push(d);
    });
    return out;
  }

  /** What kind of file this is, from its text. */
  function detectKind(text) {
    var head = String(text || '').replace(/^\uFEFF/, '').slice(0, 8000);
    if (/<nmaprun[\s>]/.test(head) || (/^\s*<\?xml/.test(head) && /nmap/i.test(head))) return 'nmap-xml';
    if (/^\s*</.test(head)) return 'xml-other';
    if (/^Host: \d{1,3}(\.\d{1,3}){3} \(/m.test(head)) return 'nmap-grepable';
    if (/^Nmap scan report for /m.test(head)) return 'nmap-normal';
    if (/^\d{6,}\s+[0-9a-fA-F:]{17}\s+\d{1,3}(\.\d{1,3}){3}\s/m.test(head)) return 'dhcp-dnsmasq';
    if (/^\s*\d{1,3}(\.\d{1,3}){3}\s+[0-9a-fA-F]{2}(-[0-9a-fA-F]{2}){5}\s+\S+\s*$/m.test(head) || /^\S+ \(\d{1,3}(\.\d{1,3}){3}\) at /m.test(head) || /^\d{1,3}(\.\d{1,3}){3}\s+dev\s+\S+\s+(lladdr|FAILED|INCOMPLETE)/m.test(head) || /^\d{1,3}(\.\d{1,3}){3}\s+ether\s+[0-9a-fA-F:]{17}/m.test(head)) return 'arp';
    var first = head.split(/\r?\n/)[0] || '';
    if (/[,;\t]/.test(first)) return 'dhcp-csv';
    return 'unknown';
  }
  var KIND_LABEL = { 'nmap-xml': 'nmap XML', 'nmap-normal': 'nmap output', 'nmap-grepable': 'nmap grepable', arp: 'ARP table', 'dhcp-csv': 'DHCP leases (CSV)', 'dhcp-dnsmasq': 'DHCP leases (dnsmasq)' };
  /** One file in, one parsed input out (never throws). */
  function readInput(text, name, opts) {
    var o = opts || {};
    var t = String(text || '');
    var fname = clean(name, 120) || 'Pasted text';
    var kind = o.kind || detectKind(t);
    var res;
    if (t.length > LIMITS.bytes) res = { kind: 'too-big', devices: [], notes: ['That file is over ' + Math.round(LIMITS.bytes / 1048576) + ' MB. Scan one network at a time.'], cidrs: [] };
    else if (kind === 'nmap-xml') res = parseNmapXml(t);
    else if (kind === 'nmap-normal') res = parseNmapNormal(t);
    else if (kind === 'nmap-grepable') res = parseGrepable(t);
    else if (kind === 'arp') res = parseArp(t);
    else if (kind === 'dhcp-csv') res = parseLeases(t, o.mapping);
    else if (kind === 'dhcp-dnsmasq') res = parseDnsmasq(t);
    else res = { kind: kind, devices: [], notes: [kind === 'xml-other' ? 'This is XML, but not from nmap. Save the scan with -oX.' : 'Zoned could not tell what this file is. It reads nmap (-oX, -oG or the normal output), ARP tables and DHCP lease exports.'], cidrs: [] };
    res.name = fname;
    res.label = KIND_LABEL[res.kind] || res.label || 'Not recognised';
    res.hash = hashText(t);
    return res;
  }

  /* ---------------- merging ---------------- */

  function deviceId(d) { return d.mac ? 'm:' + d.mac : 'i:' + d.ip; }
  function mergeInto(a, b) {
    if (!a.ip && b.ip) a.ip = b.ip;
    if (!a.mac && b.mac) a.mac = b.mac;
    if (!a.vendor && b.vendor) a.vendor = b.vendor;
    b.ipv6.forEach(function (x) { if (a.ipv6.indexOf(x) === -1 && a.ipv6.length < 4) a.ipv6.push(x); });
    b.hostnames.forEach(function (h) { addHostname(a, h); });
    b.ports.forEach(function (p) { addPort(a, p); });
    if (b.os && (!a.os || b.os.accuracy > a.os.accuracy)) a.os = b.os;
    if (!a.devicetype && b.devicetype) a.devicetype = b.devicetype;
    b.sources.forEach(function (s) { if (a.sources.indexOf(s) === -1) a.sources.push(s); });
  }
  function copyDevice(d) {
    var c = blankDevice();
    mergeInto(c, d);
    return c;
  }
  /** Several inputs -> one list of devices: the same MAC is one device; a
   *  device known only by its IP joins the one device with that IP and a MAC.
   *  An IP claimed by two different MACs keeps both, with a note. */
  function merge(inputs) {
    var byMac = Object.create(null), list = [], notes = [];
    var cidrs = [];
    (inputs || []).forEach(function (inp) {
      (inp.cidrs || []).forEach(function (c) { if (cidrs.indexOf(c) === -1) cidrs.push(c); });
    });
    var withMac = [], withoutMac = [];
    (inputs || []).forEach(function (inp) { (inp.devices || []).forEach(function (d) { (d.mac ? withMac : withoutMac).push(d); }); });
    withMac.forEach(function (d) {
      if (byMac[d.mac]) mergeInto(byMac[d.mac], d);
      else { var c = copyDevice(d); byMac[d.mac] = c; list.push(c); }
    });
    withoutMac.forEach(function (d) {
      var hits = list.filter(function (x) { return x.ip && x.ip === d.ip; });
      if (hits.length === 1) mergeInto(hits[0], d);
      else if (!hits.length) { var c = copyDevice(d); list.push(c); }
      else mergeInto(hits[0], d);
    });
    // One IP, two MACs (a lease that moved, or two devices fighting for it).
    var byIp = Object.create(null);
    list.forEach(function (d) { if (d.ip) (byIp[d.ip] = byIp[d.ip] || []).push(d); });
    Object.keys(byIp).forEach(function (ip) {
      var ds = byIp[ip];
      if (ds.length < 2) return;
      ds.forEach(function (d) { d.conflict = ds.filter(function (x) { return x !== d; }).map(function (x) { return x.mac; }); });
      notes.push(ip + ' was seen with ' + ds.length + ' different MAC addresses - an old DHCP lease, or two devices fighting over one address.');
    });
    list.sort(function (a, b) {
      if (a.ip && b.ip) return ipNum(a.ip) - ipNum(b.ip) || (a.mac < b.mac ? -1 : 1);
      if (a.ip) return -1; if (b.ip) return 1;
      return a.mac < b.mac ? -1 : 1;
    });
    if (list.length > LIMITS.devices) { notes.push('Only the first ' + fmtInt(LIMITS.devices) + ' devices are shown.'); list = list.slice(0, LIMITS.devices); }
    list.forEach(function (d) {
      d.id = deviceId(d);
      d.randomMac = randomMac(d.mac);
      d.ports.sort(function (x, y) { return x.port - y.port || (x.proto < y.proto ? -1 : 1); });
    });
    // Ids must be unique even if a device had neither (cannot happen) or two
    // IP-only entries share an IP across inputs that both lacked a MAC.
    var seen = Object.create(null);
    list.forEach(function (d) { var base = d.id, k = 2; while (seen[d.id]) d.id = base + '#' + (k++); seen[d.id] = 1; });
    return { devices: list, notes: notes, cidrs: cidrs };
  }

  /* ---------------- evidence: vendor names, models, hostnames, ports ---------------- */

  /* Each rule: [pattern, weights by role, why, flags]. flags: v = vendor name
   * only (a word too common to trust in a banner or hostname), d = a
   * factory-default model name (a hostname still set to it suggests the
   * defaults - passwords included - were never changed). Vendor names are
   * matched as nmap and DHCP exports spell them; no MAC prefix is mapped. */
  var VENDOR_RULES = [
    // Refrigeration
    [/\bdanfoss\b/i, { refrigeration: 6 }, 'Danfoss makes supermarket refrigeration controllers (AK-SM system managers, AK-CC case controllers)'],
    [/\bcopeland\b/i, { refrigeration: 6 }, 'Copeland makes refrigeration compressors and their controllers'],
    [/computer process controls/i, { refrigeration: 6 }, 'Computer Process Controls made Emerson\u2019s E2 refrigeration controllers'],
    [/\bemerson\b/i, { refrigeration: 5, hvac: 1 }, 'Emerson makes supermarket refrigeration controllers (E2, E3, Site Supervisor)'],
    [/\bcarel\b/i, { refrigeration: 5, hvac: 2 }, 'Carel makes refrigeration and HVAC controllers (pCO, pCOWeb)'],
    [/\bdixell\b/i, { refrigeration: 6 }, 'Dixell makes refrigeration case controllers and the XWEB supervisor'],
    [/\beliwell\b/i, { refrigeration: 6 }, 'Eliwell makes refrigeration controllers'],
    [/\bhussmann\b/i, { refrigeration: 5 }, 'Hussmann makes supermarket refrigerated cases'],
    [/\bheatcraft\b/i, { refrigeration: 5 }, 'Heatcraft makes commercial refrigeration'],
    // HVAC and building automation
    [/\bjohnson controls\b|\bmetasys\b/i, { hvac: 6 }, 'Johnson Controls makes building controllers (Metasys)'],
    [/\bhoneywell\b(?! home)/i, { hvac: 5 }, 'Honeywell makes building and HVAC controllers (it also makes scanners - check)'],
    [/\bsiemens\b/i, { hvac: 5 }, 'Siemens makes building controllers (Desigo, Apogee)'],
    [/\bschneider\b/i, { hvac: 4, lighting: 2 }, 'Schneider Electric makes building and energy controllers'],
    [/\btridium\b|\bniagara\b/i, { hvac: 6 }, 'Tridium makes the Niagara building-automation framework (JACE controllers)'],
    [/\bdistech\b/i, { hvac: 6 }, 'Distech makes building controllers'],
    [/\bdelta controls\b/i, { hvac: 6 }, 'Delta Controls makes BACnet building controllers'],
    [/\bautomated logic\b|\bwebctrl\b/i, { hvac: 6 }, 'Automated Logic makes building controllers (WebCTRL)'],
    [/\btrane\b/i, { hvac: 6 }, 'Trane makes HVAC equipment and its controllers'],
    [/\bcarrier\b/i, { hvac: 5 }, 'Carrier makes HVAC equipment and its controllers', 'v'],
    [/\bdaikin\b/i, { hvac: 6 }, 'Daikin makes HVAC units and their network adapters'],
    [/\bmitsubishi\b/i, { hvac: 4 }, 'Mitsubishi Electric makes HVAC units and their network adapters'],
    [/\blennox\b/i, { hvac: 6 }, 'Lennox makes rooftop HVAC units and their controllers'],
    [/\breliable controls\b|\bkmc controls\b|\balerton\b/i, { hvac: 6 }, 'A maker of BACnet building controllers'],
    [/\bcontemporary control/i, { hvac: 5 }, 'Contemporary Controls makes BACnet routers and building controllers'],
    [/\bbelimo\b/i, { hvac: 5 }, 'Belimo makes HVAC valves and actuators with network interfaces'],
    [/\bloytec\b/i, { hvac: 4, lighting: 2 }, 'LOYTEC makes building-automation controllers'],
    // Lighting and energy
    [/\blutron\b/i, { lighting: 6 }, 'Lutron makes lighting control systems'],
    [/\bacuity\b|\bnlight\b/i, { lighting: 6 }, 'Acuity Brands makes lighting controls (nLight)'],
    [/\bleviton\b/i, { lighting: 5 }, 'Leviton makes lighting controls and energy meters'],
    [/\bsignify\b|philips lighting/i, { lighting: 5 }, 'Signify (Philips Lighting) makes lighting controls'],
    [/\benlighted\b|\bdigital lumens\b|\bdaintree\b/i, { lighting: 6 }, 'A maker of networked lighting controls'],
    [/\begauge\b/i, { lighting: 6 }, 'eGauge makes energy meters'],
    // Remote access: cellular routers and industrial gateways
    [/\bsierra wireless\b|\bairlink\b/i, { remote: 7 }, 'Sierra Wireless makes AirLink cellular routers, which contractors use for remote access'],
    [/\bcradlepoint\b/i, { remote: 7 }, 'Cradlepoint makes cellular routers, which contractors use for remote access'],
    [/\bdigi international\b|^digi\b/i, { remote: 6 }, 'Digi makes cellular routers and remote-access gateways', 'v'],
    [/\bteltonika\b/i, { remote: 7 }, 'Teltonika makes cellular routers (RUT series), common as contractor modems'],
    [/\bmoxa\b/i, { remote: 4, hvac: 1 }, 'Moxa makes industrial gateways and serial-to-network servers'],
    [/\bewon\b|\bhms industrial\b/i, { remote: 6 }, 'HMS makes eWON remote-access gateways for machines'],
    [/\binhand\b|\brobustel\b/i, { remote: 6 }, 'A maker of industrial cellular routers'],
    [/\bpeplink\b|\bpepwave\b/i, { remote: 5 }, 'Peplink makes cellular routers'],
    [/\bmulti-?tech\b/i, { remote: 5 }, 'Multi-Tech makes cellular modems'],
    [/\blantronix\b/i, { remote: 4 }, 'Lantronix makes serial-to-network servers and remote-access boxes'],
    [/\binseego\b|\bnovatel\b/i, { remote: 5 }, 'A maker of cellular hotspots and routers'],
    // Cameras
    [/\bhikvision\b/i, { camera: 7 }, 'Hikvision makes security cameras and recorders'],
    [/\bdahua\b/i, { camera: 7 }, 'Dahua makes security cameras and recorders'],
    [/\baxis communications\b|^axis\b/i, { camera: 6 }, 'Axis makes network cameras', 'v'],
    [/\bhanwha\b|samsung techwin/i, { camera: 6 }, 'Hanwha (Samsung Techwin) makes security cameras'],
    [/\buniview\b|\bamcrest\b|\blorex\b|\breolink\b|\bvivotek\b|\bavigilon\b|\bmobotix\b|\bwyze\b/i, { camera: 6 }, 'A maker of security cameras'],
    // Payments
    [/\bverifone\b/i, { pos: 7 }, 'Verifone makes card terminals and PIN pads'],
    [/\bingenico\b/i, { pos: 7 }, 'Ingenico makes card terminals and PIN pads'],
    [/\bpax\b/i, { pos: 6 }, 'PAX makes card terminals', 'v'],
    [/\bncr\b/i, { pos: 6 }, 'NCR makes tills and self-checkouts', 'v'],
    [/toshiba global commerce|toshiba tec/i, { pos: 6 }, 'Toshiba makes retail tills'],
    [/\bdiebold\b|\bwincor\b/i, { pos: 6 }, 'Diebold Nixdorf makes tills and self-checkouts'],
    [/\bcastles\b|\bhypercom\b|\bfirst data\b|\bfiserv\b|\bclover\b/i, { pos: 6 }, 'A maker of card terminals'],
    [/^square\b|\bblock,? inc/i, { pos: 6 }, 'Square makes card readers and tills', 'v'],
    [/\belo touch\b|\bposiflex\b/i, { pos: 5 }, 'A maker of POS touchscreen terminals'],
    // Printers
    [/\bbrother\b|\bkyocera\b|\blexmark\b|\bxerox\b|\bricoh\b|\bkonica\b/i, { printer: 6 }, 'A maker of office printers'],
    [/\bepson\b|\bseiko epson\b/i, { printer: 5 }, 'Epson makes office and receipt printers'],
    [/\bcanon\b/i, { printer: 5 }, 'Canon makes office printers'],
    [/\bzebra\b/i, { printer: 5 }, 'Zebra makes label and receipt printers'],
    [/\bstar micronics\b/i, { printer: 6 }, 'Star Micronics makes receipt printers'],
    [/hewlett.?packard|^hp\b|\bhp inc/i, { printer: 3, office: 2 }, 'HP makes printers and PCs'],
    // Network gear
    [/\bcisco\b|\bmeraki\b/i, { network: 5 }, 'Cisco makes switches, routers and access points'],
    [/\bubiquiti\b/i, { network: 5, camera: 1 }, 'Ubiquiti makes routers, switches and access points (and some cameras)'],
    [/\bnetgear\b|\btp-?link\b|\bd-link\b|\bzyxel\b|\bdraytek\b|\bengenius\b/i, { network: 4 }, 'A maker of routers, switches and access points'],
    [/\baruba\b|\bjuniper\b|\bruckus\b|\bmikrotik\b|\brouterboard\b|\bnetgate\b/i, { network: 5 }, 'A maker of network switches, routers or access points'],
    [/\bfortinet\b|\bsonicwall\b|\bwatchguard\b|\bpalo alto\b|\bsophos\b/i, { network: 6 }, 'A maker of firewalls'],
    [/american power conversion|\bapc\b|\bschneider electric it\b|\beaton\b|\bvertiv\b/i, { network: 4 }, 'The network card of a UPS (battery backup)'],
    // Office
    [/\bdell\b|\blenovo\b/i, { office: 4 }, 'Dell and Lenovo make office PCs and servers'],
    [/\bsynology\b|\bqnap\b|\bwestern digital\b|\bbuffalo\b/i, { office: 6 }, 'A maker of network storage (NAS)'],
    [/\bvmware\b|\bsuper ?micro\b|\bgiga-?byte\b|\bmicro-star\b|\basustek\b/i, { office: 3 }, 'A maker of PCs, servers or their network cards'],
    [/\bmicrosoft\b/i, { office: 3 }, 'Microsoft makes Surface PCs and Xbox consoles', 'v'],
    [/\bintel\b/i, { office: 2, guest: 1 }, 'Intel makes the network cards in many PCs and laptops'],
    // Personal devices
    [/\bapple\b/i, { guest: 4, office: 1 }, 'Apple makes iPhones, iPads and Macs'],
    [/\bsamsung\b(?! techwin)/i, { guest: 3, iot: 1 }, 'Samsung makes phones, tablets and TVs'],
    [/\bgoogle\b/i, { guest: 3, iot: 2 }, 'Google makes Pixel phones and Nest devices'],
    [/\boneplus\b|\bxiaomi\b|\bmotorola\b|\boppo\b|\bhuawei\b|\bhtc\b|\bmurata\b/i, { guest: 4 }, 'A maker of phones and tablets'],
    // Smart / IoT
    [/\becobee\b/i, { iot: 7 }, 'ecobee makes smart thermostats'],
    [/\bnest\b|honeywell home|\bresideo\b|\bsensi\b/i, { iot: 6 }, 'A maker of smart thermostats'],
    [/\bsonos\b|\broku\b/i, { iot: 6 }, 'A maker of speakers and TV players'],
    [/\bamazon\b/i, { iot: 4, guest: 1 }, 'Amazon makes Echo speakers and Fire TV sticks'],
    [/\bespressif\b/i, { iot: 6 }, 'Espressif makes the Wi-Fi chips inside many cheap smart devices'],
    [/\btuya\b|\bshelly\b|\ballterco\b|\bchamberlain\b|\bbelkin\b|\bwemo\b/i, { iot: 6 }, 'A maker of smart plugs, switches and openers'],
    [/\braspberry pi\b/i, { iot: 3, office: 2 }, 'A Raspberry Pi - a small computer used for many things'],
  ];
  var MODEL_RULES = [
    [/\bxweb\s?\d*\w*/i, { refrigeration: 6 }, 'XWEB is Dixell\u2019s refrigeration supervisor', 'd'],
    [/\bak-?sm\s?\d+|\bak-?cc\s?\d+/i, { refrigeration: 6 }, 'AK-SM and AK-CC are Danfoss refrigeration controllers', 'd'],
    [/\bpcoweb\b/i, { refrigeration: 4, hvac: 3 }, 'pCOWeb is the network card of a Carel controller', 'd'],
    [/\bsite supervisor\b|\bultrasite\b|\be[23][- _]?(?:rack|controller|supervisory|einstein)\b/i, { refrigeration: 5 }, 'Emerson\u2019s E2/E3 or Site Supervisor refrigeration controller', 'd'],
    [/\bjace(?:[- ]?\d+)?\b/i, { hvac: 6 }, 'A JACE is a Tridium Niagara building controller', 'd'],
    [/\bnae\d{2,}\b|\bsnc\d{3,}\b/i, { hvac: 5 }, 'NAE and SNC are Johnson Controls Metasys engines', 'd'],
    [/\bdesigo\b|\bapogee\b|\bpxc\d+\b/i, { hvac: 5 }, 'Desigo, Apogee and PXC are Siemens building controllers', 'd'],
    [/\bibr\d{3,4}\w*|\bcba\d{3}\b|\bmbr\d{3,4}\b/i, { remote: 6 }, 'A Cradlepoint cellular router model', 'd'],
    [/\brutx?\d{2,3}\b|\btrb\d{3}\b/i, { remote: 6 }, 'A Teltonika cellular router model', 'd'],
    [/\blx[46]0\b|\brv5[05]x?\b|\bgx450\b|\bmp70\b|\bes450\b|\baleos\b|\bacemanager\b/i, { remote: 6 }, 'A Sierra Wireless AirLink cellular router (ALEOS / ACEmanager)', 'd'],
    [/\bds-\d{1,2}[a-z]{2,3}\d{2,}|\bds-\d{4}[a-z]{1,3}\b/i, { camera: 6 }, 'DS-2CD\u2026 and DS-7\u2026 are Hikvision camera and recorder models', 'd'],
    [/\b(?:ipc|dh-ipc|nvr|dvr)[-_]?\w*/i, { camera: 4 }, 'Named like a camera or recorder'],
    [/\btm-[a-z]\d{2,}/i, { printer: 5 }, 'TM-\u2026 is an Epson receipt printer model', 'd'],
    [/\blaserjet\b|\bofficejet\b|\bdeskjet\b|\bmfc-\w+|\bdcp-\w+/i, { printer: 5 }, 'A printer model name'],
  ];
  var HOSTNAME_RULES = [
    [/\b(?:till|register|checkout|pinpad|pin-pad|ped|pos)(?:[-_]?\d+)?\b|\blane[-_]?\d+\b|\bpaypoint\b/i, { pos: 5 }, 'named like a till or card reader'],
    [/\b(?:rack|reefer|refrig\w*|freezer|cooler|walk-?in|case[-_]?(?:ctrl|\d+))\b/i, { refrigeration: 4 }, 'named like refrigeration'],
    [/\b(?:rtu|ahu|vav|hvac|chiller|boiler|bacnet|fcu)(?:[-_]?\d+)?\b/i, { hvac: 4 }, 'named like HVAC equipment'],
    [/\b(?:bms|bas|ems|facilities|supervisor|frontend|front-end)\b/i, { bms: 6 }, 'named like a building-management PC'],
    [/\b(?:light(?:ing)?|dimmer|lcp)(?:[-_]?\d+)?\b/i, { lighting: 4 }, 'named like a lighting controller'],
    [/\b(?:lte|4g|5g|cellular|cell-?modem|modem|remote-?access|vpn-?gw)\b/i, { remote: 4 }, 'named like a cellular or remote-access box'],
    [/\b(?:cam(?:era)?|nvr|dvr|cctv)(?:[-_]?\d+)?\b/i, { camera: 5 }, 'named like a camera or recorder'],
    [/\b(?:printer|prn\d*|mfp|copier|label-?printer)\b/i, { printer: 5 }, 'named like a printer'],
    [/\b(?:router|gateway|gw|firewall|fw\d*|switch|sw[-_]?\d+|ap[-_]?\d+|wap|usg|udm|edgerouter|ap-[a-z]+)\b/i, { network: 4 }, 'named like network gear'],
    [/\b(?:iphone|ipad|android|galaxy|pixel|oneplus|redmi|macbook|ipod|apple-?watch|phone)\b/i, { guest: 5 }, 'named like a phone, tablet or laptop'],
    [/\b(?:nas|server|srv\d*|backoffice|back-office|office|manager|mgr|desktop|pc\d*|laptop)\b|^desktop-[a-z0-9]{7}$|^win-[a-z0-9]{8,}$/i, { office: 3 }, 'named like an office PC or server'],
    [/\b(?:esp[_-]?[0-9a-f]{6}|tasmota|shelly\w*|sonos\w*|roku\w*|echo|alexa|chromecast|ecobee\w*|nest|thermostat|tstat)\b/i, { iot: 4 }, 'named like a smart device'],
  ];
  var DEVICETYPE = [
    [/printer/i, { printer: 4 }], [/webcam|camera/i, { camera: 4 }], [/router|switch|wap|firewall|bridge|hub|broadband/i, { network: 4 }],
    [/phone/i, { guest: 3 }], [/media device|game console|power-device/i, { iot: 3 }], [/plc|specialized|security-misc/i, { hvac: 1, refrigeration: 1 }],
  ];

  function add(ev, kind, role, w, text) { ev.push({ kind: kind, role: role, w: w, text: text }); }
  /** Each rule's explanation is given once per device: a vendor named again
   *  in a banner or a hostname says where, not the same sentence again. */
  function applyRules(ev, rules, value, kind, label, scale, skipVendorOnly) {
    if (!value) return;
    var told = ev.told || (ev.told = {});
    rules.forEach(function (r) {
      if (skipVendorOnly && r[3] === 'v') return;
      var m = r[0].exec(value);
      if (!m) return;
      Object.keys(r[1]).forEach(function (role) {
        var w = Math.max(1, r[1][role] + (scale || 0));
        var why = told[r[2] + '|' + role] ? '' : ' - ' + r[2];
        add(ev, kind, role, w, label.replace('%s', clean(m[0], 60)) + why);
        ev[ev.length - 1].rule = r[2];
        told[r[2] + '|' + role] = 1;
      });
    });
  }
  function banners(d) {
    var out = [];
    openPorts(d).forEach(function (p) {
      var t = [p.product, p.version, p.extrainfo, p.title, p.banner].filter(Boolean).join(' ');
      if (t) out.push({ port: p, text: t });
    });
    return out;
  }
  function generalOs(d) {
    var op = openPorts(d);
    var win = d.os && /windows/i.test(d.os.name);
    return Boolean(win || op.some(function (p) { return p.port === 445 || p.port === 135; }));
  }
  /** An admin page on plain HTTP with no HTTPS beside it. */
  function httpOnly(d) {
    var op = openPorts(d);
    return op.some(function (p) { return HTTP_PORTS[p.port] && p.proto === 'tcp'; }) && !op.some(function (p) { return HTTPS_PORTS[p.port] && p.proto === 'tcp'; });
  }
  /** "HVAC / building controller", "refrigeration controller" - for a sentence. */
  function lowerLabel(role) { var l = ROLES[role].label; return /^[A-Z][a-z]/.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l; }
  function has(d, port, proto) { return openPorts(d).some(function (p) { return p.port === port && (!proto || p.proto === proto); }); }
  function hasAny(d, list) { return openPorts(d).filter(function (p) { return list.indexOf(p.port) !== -1; }); }

  /** Every piece of evidence for a device, each pointing at a role with a
   *  weight and a sentence. */
  function evidence(d) {
    var ev = [];
    // 1. The vendor name the scan tool resolved.
    if (d.vendor) applyRules(ev, VENDOR_RULES, d.vendor, 'vendor', 'Network card made by %s', 0);
    // 2. Banners: product names, versions, web page titles.
    var seenBanner = {};
    banners(d).forEach(function (b) {
      var tmp = []; tmp.told = ev.told || (ev.told = {});
      applyRules(tmp, VENDOR_RULES, b.text, 'banner', 'Port ' + b.port.port + ' says \u201c%s\u201d', 0, true);
      applyRules(tmp, MODEL_RULES, b.text, 'banner', 'Port ' + b.port.port + ' says \u201c%s\u201d', 0);
      tmp.forEach(function (e) { var k = e.role + '|' + (e.rule || e.text); if (!seenBanner[k]) { seenBanner[k] = 1; ev.push(e); } });
    });
    // 3. Hostnames.
    var seenHost = {};
    d.hostnames.forEach(function (h) {
      var tmp = []; tmp.told = ev.told || (ev.told = {});
      applyRules(tmp, MODEL_RULES, h, 'hostname', 'Named \u201c' + clean(h, 60) + '\u201d', 0);
      applyRules(tmp, VENDOR_RULES, h, 'hostname', 'Named \u201c' + clean(h, 60) + '\u201d', -1, true);
      HOSTNAME_RULES.forEach(function (r) {
        if (r[0].test(h)) Object.keys(r[1]).forEach(function (role) { add(tmp, 'hostname', role, r[1][role], 'Named \u201c' + clean(h, 60) + '\u201d - ' + r[2]); tmp[tmp.length - 1].rule = r[2]; });
      });
      tmp.forEach(function (e) { var k = e.role + '|' + (e.rule || e.text.replace(/^Named “[^”]*”/, '')); if (!seenHost[k]) { seenHost[k] = 1; ev.push(e); } });
    });
    // 4. Ports and protocols.
    var gen = generalOs(d);
    if (has(d, 47808)) { if (gen) add(ev, 'port', 'bms', 7, 'BACnet/IP (47808) on a Windows PC - a building-management workstation'); else { add(ev, 'port', 'hvac', 4, 'Answers BACnet/IP on 47808 - the building-automation protocol'); add(ev, 'port', 'refrigeration', 2, 'Answers BACnet/IP on 47808 - refrigeration controllers use it too'); } }
    if (hasAny(d, [1911, 4911]).length) { if (gen) add(ev, 'port', 'bms', 7, 'Niagara Fox (1911/4911) on a Windows PC - a Niagara supervisor'); else add(ev, 'port', 'hvac', 6, 'Niagara Fox on 1911/4911 - Tridium Niagara building automation'); }
    if (has(d, 502, 'tcp')) { add(ev, 'port', 'refrigeration', 2, 'Modbus TCP on 502 - an industrial control protocol'); add(ev, 'port', 'hvac', 2, 'Modbus TCP on 502 - an industrial control protocol'); add(ev, 'port', 'lighting', 1, 'Modbus TCP on 502 - also used by energy meters'); }
    if (hasAny(d, [1628, 1629]).length) { add(ev, 'port', 'hvac', 3, 'LonWorks/IP on 1628/1629 - building automation'); add(ev, 'port', 'lighting', 1, 'LonWorks/IP - also used for lighting'); }
    if (has(d, 3671)) { add(ev, 'port', 'lighting', 4, 'KNX/IP on 3671 - lighting and building control'); add(ev, 'port', 'hvac', 2, 'KNX/IP on 3671 - building control'); }
    if (has(d, 20000, 'tcp')) add(ev, 'port', 'lighting', 4, 'DNP3 on 20000 - energy meters and utility equipment');
    if (has(d, 102, 'tcp')) { add(ev, 'port', 'hvac', 2, 'Siemens S7 on 102 - an industrial controller protocol'); add(ev, 'port', 'refrigeration', 1, 'Siemens S7 on 102 - an industrial controller protocol'); }
    if (has(d, 44818, 'tcp')) { add(ev, 'port', 'hvac', 2, 'EtherNet/IP on 44818 - an industrial controller protocol'); add(ev, 'port', 'refrigeration', 1, 'EtherNet/IP on 44818 - an industrial controller protocol'); }
    if (hasAny(d, [1883, 8883]).length) { add(ev, 'port', 'iot', 3, 'MQTT (1883/8883) - how smart devices talk to their cloud'); add(ev, 'port', 'hvac', 1, 'MQTT - also used by building sensors'); }
    if (has(d, 554)) add(ev, 'port', 'camera', 5, 'RTSP video on 554 - cameras and recorders stream on it');
    if (has(d, 37777)) add(ev, 'port', 'camera', 5, 'Port 37777 - Dahua cameras and recorders use it');
    if (has(d, 9100)) add(ev, 'port', 'printer', 5, 'Raw printing (JetDirect) on 9100');
    if (has(d, 631)) add(ev, 'port', 'printer', 3, 'IPP printing on 631');
    if (has(d, 515)) add(ev, 'port', 'printer', 2, 'LPD printing on 515');
    if (hasAny(d, [135, 139, 445]).length) add(ev, 'port', 'office', 3, 'Windows file sharing (135/139/445) - a Windows PC or a file server');
    if (has(d, 3389)) add(ev, 'port', 'office', 1, 'Remote Desktop on 3389 - a Windows PC');
    if (has(d, 53)) add(ev, 'port', 'network', 3, 'Answers DNS on 53 - usually the router');
    if (has(d, 5938)) { add(ev, 'port', 'bms', 1, 'TeamViewer on 5938 - often left on a PC a contractor looks after'); add(ev, 'port', 'remote', 1, 'TeamViewer on 5938 - remote control'); }
    // 5. What nmap guessed the device or its operating system to be.
    var types = uniq([d.devicetype, d.os && d.os.type].filter(Boolean).map(function (t) { return t.toLowerCase(); }));
    types.forEach(function (t) { DEVICETYPE.forEach(function (r) { if (r[0].test(t)) Object.keys(r[1]).forEach(function (role) { add(ev, 'os', role, r[1][role], 'nmap calls it a \u201c' + clean(t, 40) + '\u201d device'); }); }); });
    if (d.os && d.os.name) {
      if (/windows/i.test(d.os.name)) add(ev, 'os', 'office', 2, 'nmap guesses ' + clean(d.os.name, 60));
      else if (/\b(ios|iphone|ipad|android)\b/i.test(d.os.name)) add(ev, 'os', 'guest', 5, 'nmap guesses ' + clean(d.os.name, 60));
      else if (/\b(vxworks|qnx|threadx|nucleus|embedded)\b/i.test(d.os.name)) { add(ev, 'os', 'hvac', 1, 'nmap guesses an embedded system (' + clean(d.os.name, 40) + ')'); add(ev, 'os', 'refrigeration', 1, 'nmap guesses an embedded system (' + clean(d.os.name, 40) + ')'); }
    }
    // 6. The address itself.
    if (d.randomMac) add(ev, 'mac', 'guest', 5, 'A private (randomised) Wi-Fi address - phones and laptops use these');
    return ev;
  }

  /** A role, a confidence and the evidence. An override from the user wins. */
  function classify(d, override) {
    var ev = evidence(d);
    var score = {};
    ev.forEach(function (e) { score[e.role] = (score[e.role] || 0) + e.w; });
    var ranked = Object.keys(score).sort(function (a, b) { return score[b] - score[a] || ROLE_KEYS.indexOf(a) - ROLE_KEYS.indexOf(b); });
    var top = ranked[0], s1 = top ? score[top] : 0, second = ranked[1], s2 = second ? score[second] : 0;
    var role = 'unknown', conf = 'low';
    if (s1 >= 3) {
      role = top;
      conf = s1 >= 7 && s2 <= s1 * 0.5 ? 'high' : s1 >= 4 && s2 < s1 * 0.75 ? 'medium' : 'low';
    }
    var alt = role !== 'unknown' && second && s2 >= 3 && s2 >= s1 * 0.6 ? second : (role === 'unknown' && top && s1 > 0 ? top : null);
    var auto = { role: role, conf: conf, alt: alt };
    if (override && ROLES[override] && override !== role) return { role: override, conf: 'you', alt: null, auto: auto, evidence: ev, score: score, overridden: true };
    if (override && override === role) return { role: role, conf: 'you', alt: null, auto: auto, evidence: ev, score: score, overridden: true };
    return { role: role, conf: conf, alt: alt, auto: auto, evidence: ev, score: score, overridden: false };
  }
  /** The evidence grouped by role, strongest first, for "Why we think so". */
  function evidenceByRole(cls) {
    var groups = {};
    cls.evidence.forEach(function (e) { (groups[e.role] = groups[e.role] || { role: e.role, w: 0, items: [] }).items.push(e); groups[e.role].w += e.w; });
    return Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return b.w - a.w; });
  }
  /** "Hikvision Digital Technology" -> "Hikvision". */
  function shortVendor(v) {
    var s = clean(v, 80).replace(/^(zhejiang|shenzhen|shanghai|guangzhou|hangzhou|beijing|xiamen)\s+/i, '')
      .replace(/[,.]/g, ' ').replace(/\b(digital technology|technologies|technology|electronics?|industries|incorporated|inc|corp|corporation|co|ltd|limited|gmbh|llc|systems|networks|international|communications|global|company)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    var w = s.split(' ').slice(0, 2).join(' ');
    return w || clean(v, 30);
  }
  /** A name a person can recognise: the hostname (without a home-network
   *  suffix), else the maker and what it is, with the last part of its address. */
  function displayName(d) {
    var h = d.hostnames[0];
    if (h) { var s = h.replace(/\.(local|lan|home|localdomain|internal|corp|home\.arpa)$/i, '').replace(/^([^.]{3,})\..*$/, '$1'); return s.length > 40 ? s.slice(0, 39) + '…' : s; }
    var last = d.ip ? ' .' + d.ip.split('.')[3] : (d.mac ? ' ' + d.mac.slice(-5) : '');
    var what = d.cls && d.cls.role !== 'unknown' ? ROLES[d.cls.role].short.toLowerCase() : 'device';
    var who = d.vendor && !/^private$/i.test(d.vendor) ? shortVendor(d.vendor) : '';
    return (who ? who + ' ' + what : cap(what)) + last;
  }

  /* ---------------- networks ---------------- */

  /** Which network a device is on: the smallest scanned range that holds its
   *  address, else its /24. */
  function networkOf(d, cidrs) {
    if (!d.ip) return 'unknown';
    var best = null;
    (cidrs || []).forEach(function (c) { var p = parseCidr(c); if (p && inCidr(d.ip, p) && (!best || p.bits > best.bits)) best = p; });
    if (best) return best.cidr;
    return parseCidr(d.ip + '/24').cidr;
  }
  /** The block suggested subnets come from: 10.10.<vlan>.0/24, or
   *  172.16.<vlan>.0/24 when the network in use is already inside 10.10. */
  function subnetScheme(devices) {
    var clash = devices.some(function (d) { return d.ip && /^10\.10\./.test(d.ip); });
    return clash ? '172.16' : '10.10';
  }

  /* ---------------- findings ---------------- */

  var FINDING_ORDER = ['ot-with-pos', 'ot-with-office', 'remote-gateway', 'open-ot-protocols', 'cleartext', 'guest-on-business', 'remote-desktop', 'cameras-on-pos', 'http-admin', 'default-names', 'unknowns', 'no-pos', 'pci-scope', 'separate'];

  function roleCountWords(list, opts) {
    var by = {};
    list.forEach(function (d) { by[d.cls.role] = (by[d.cls.role] || 0) + 1; });
    var parts = [];
    var names = { refrigeration: ['refrigeration controller', 'refrigeration controllers'], hvac: ['HVAC controller', 'HVAC controllers'], lighting: ['lighting controller', 'lighting controllers'], bms: ['building-management PC', 'building-management PCs'], remote: ['remote-access box', 'remote-access boxes'], iot: ['smart device', 'smart devices'] };
    Object.keys(names).forEach(function (r) { if (by[r]) parts.push((opts && opts.digits ? fmtInt(by[r]) : words(by[r])) + ' ' + names[r][by[r] === 1 ? 0 : 1]); });
    return parts;
  }
  function shortList(devs) { return devs.map(function (d) { return displayName(d) + (d.ip ? ' (' + d.ip + ')' : ''); }); }

  /** Ranked findings: id, severity, title, detail, fix, the devices (ids). */
  function findings(devices, cidrs) {
    var out = [];
    var net = {};
    devices.forEach(function (d) { d.net = networkOf(d, cidrs); (net[d.net] = net[d.net] || []).push(d); });
    var R = function (d) { return d.cls.role; };
    var isCtl = function (d) { return CONTROLLERS.indexOf(R(d)) !== -1; };
    var isOt = function (d) { return ROLES[R(d)].ot; };
    var pos = devices.filter(function (d) { return R(d) === 'pos'; });
    var posNets = uniq(pos.map(function (d) { return d.net; }));
    var office = devices.filter(function (d) { return R(d) === 'office' || R(d) === 'printer'; });
    var officeNets = uniq(office.map(function (d) { return d.net; }));
    var ot = devices.filter(isOt);
    var shareWith = function (list, nets) { return list.filter(function (d) { return nets.indexOf(d.net) !== -1; }); };

    // OT on the payments network - the headline.
    var otPos = shareWith(ot, posNets);
    var posWithOt = pos.filter(function (p) { return otPos.some(function (o) { return o.net === p.net; }); });
    if (otPos.length) {
      var ctl = otPos.filter(isCtl), others = otPos.filter(function (d) { return !isCtl(d); });
      var headCount = ctl.filter(function (d) { return R(d) === 'refrigeration' || R(d) === 'hvac'; });
      var headWhat;
      if (headCount.length) {
        var hasR = headCount.some(function (d) { return R(d) === 'refrigeration'; }), hasH = headCount.some(function (d) { return R(d) === 'hvac'; });
        headWhat = fmtInt(headCount.length) + ' ' + (hasR && hasH ? 'refrigeration and HVAC' : hasR ? 'refrigeration' : 'HVAC') + ' controller' + (headCount.length === 1 ? '' : 's');
      } else headWhat = plural(otPos.length, 'building device');
      var rest = otPos.filter(function (d) { return headCount.indexOf(d) === -1; });
      out.push({
        id: 'ot-with-pos', severity: 'high',
        title: headWhat + ' share' + (headCount.length === 1 || (!headCount.length && otPos.length === 1) ? 's' : '') + ' a network with your ' + plural(posWithOt.length, 'till'),
        detail: 'Anyone who gets into one can reach the others. Building controllers run old software, keep factory passwords and are looked after by an outside contractor - and on this network nothing stands between them and the devices that take cards.' + (rest.length && headCount.length ? ' Also on it: ' + andList(roleCountWords(rest)) + '.' : ''),
        fix: 'Move the building devices to their own zone (Building & OT) and the tills to theirs (Payments), with nothing allowed from one to the other. The Plan tab has the zones and the rules.',
        devices: otPos.concat(posWithOt).map(function (d) { return d.id; }), tab: 'plan',
      });
    } else {
      var otOff = shareWith(ot.filter(function (d) { return R(d) !== 'iot'; }), officeNets);
      if (otOff.length) out.push({
        id: 'ot-with-office', severity: 'medium',
        title: plural(otOff.length, 'building device') + ' share' + (otOff.length === 1 ? 's' : '') + ' a network with your office PCs',
        detail: 'An office PC that opens the wrong email attachment can reach the controllers that keep the building running. Building controllers rarely get security updates.',
        fix: 'Move the building devices to their own zone (Building & OT). The Plan tab has the zones and the rules.',
        devices: otOff.map(function (d) { return d.id; }), tab: 'plan',
      });
    }

    // Remote-access gateways on the flat network.
    var remote = devices.filter(function (d) { return R(d) === 'remote'; });
    var bizNets = uniq(posNets.concat(officeNets));
    var remoteFlat = remote.filter(function (d) { return bizNets.indexOf(d.net) !== -1 || !bizNets.length; });
    if (remoteFlat.length) out.push({
      id: 'remote-gateway', severity: 'high',
      title: remoteFlat.length === 1 ? 'A remote-access box connects this network to the internet around your firewall' : remoteFlat.length + ' remote-access boxes connect this network to the internet around your firewall',
      detail: 'A cellular router or remote-access gateway brings its own internet connection. Whatever the contractor set up on it - port forwards, a VPN, a cloud portal - reaches every device on this network, and your firewall never sees it. A scan from inside cannot see its port forwards either: ask the contractor (the letter does).',
      fix: 'Unplug it once the contractor has another way in: your firewall\u2019s VPN, into the Building & OT zone only. Until then, move it into that zone so it reaches the controllers and nothing else.',
      devices: remoteFlat.map(function (d) { return d.id; }), tab: 'contractor',
    });

    // Building protocols with no password, reachable from everything.
    var otp = [], otpDevs = [];
    devices.forEach(function (d) {
      var hit = openPorts(d).filter(function (p) { return OT_PORTS[p.port + '/' + p.proto]; });
      if (hit.length && (net[d.net] || []).some(function (x) { return !isOt(x) && R(x) !== 'unknown'; })) { otpDevs.push(d); hit.forEach(function (p) { otp.push(OT_PORTS[p.port + '/' + p.proto]); }); }
    });
    if (otpDevs.length) {
      var counts = {};
      otp.forEach(function (n) { counts[n] = (counts[n] || 0) + 1; });
      out.push({
        id: 'open-ot-protocols', severity: 'high',
        title: 'Building-control protocols with no password are open to every device',
        detail: andList(Object.keys(counts).map(function (k) { return k + ' on ' + plural(counts[k], 'device'); })) + '. These protocols were designed for closed networks: anything that can reach the port can read a setpoint - or change one - without logging in.',
        fix: 'Only the building-management PC (and the contractor through your VPN) should reach these ports. The rule table allows exactly that.',
        devices: otpDevs.map(function (d) { return d.id; }), tab: 'plan',
      });
    }

    // Plain-text logins.
    var clear = devices.filter(function (d) { return openPorts(d).some(function (p) { return CLEAR_PORTS[p.port + '/' + p.proto]; }); });
    if (clear.length) {
      var cn = uniq([].concat.apply([], clear.map(function (d) { return openPorts(d).filter(function (p) { return CLEAR_PORTS[p.port + '/' + p.proto]; }).map(function (p) { return CLEAR_PORTS[p.port + '/' + p.proto]; }); })));
      out.push({
        id: 'cleartext', severity: 'high',
        title: andList(cn) + ' (passwords sent in plain text) ' + (cn.length === 1 ? 'is' : 'are') + ' open on ' + plural(clear.length, 'device'),
        detail: 'Anyone on the same network can read the password as it is typed. On a flat network that includes every guest phone.',
        fix: 'Ask the contractor to turn ' + andList(cn) + ' off and use SSH or HTTPS. Until then the zone plan keeps everyone else away from these ports.',
        devices: clear.map(function (d) { return d.id; }), tab: 'contractor',
      });
    }

    // Guests and personal devices on the business network.
    var guests = devices.filter(function (d) { return R(d) === 'guest'; });
    var guestFlat = shareWith(guests, bizNets);
    if (guestFlat.length) out.push({
      id: 'guest-on-business', severity: posNets.some(function (n) { return guestFlat.some(function (g) { return g.net === n; }); }) ? 'high' : 'medium',
      title: plural(guestFlat.length, 'phone or personal device', 'phones and personal devices') + ' share the business network',
      detail: 'Guest Wi-Fi bridged into the same network as the tills means any customer\u2019s phone - or whatever is on it - is one hop from your card terminals and controllers.',
      fix: 'Put guest Wi-Fi on its own network (the Guest zone): internet only, each device isolated from the others. Staff phones go there too.',
      devices: guestFlat.map(function (d) { return d.id; }), tab: 'plan',
    });

    // Remote-control services.
    var rd = devices.filter(function (d) { return openPorts(d).some(function (p) { return REMOTE_PORTS[p.port + '/' + p.proto]; }); });
    if (rd.length) {
      var rn = uniq([].concat.apply([], rd.map(function (d) { return openPorts(d).filter(function (p) { return REMOTE_PORTS[p.port + '/' + p.proto]; }).map(function (p) { return REMOTE_PORTS[p.port + '/' + p.proto]; }); })));
      out.push({
        id: 'remote-desktop', severity: rd.some(isOt) ? 'medium' : 'medium',
        title: 'Remote-control services are open on ' + plural(rd.length, 'device') + ' (' + andList(rn) + ')',
        detail: 'Anyone on the network can try passwords against ' + (rn.length === 1 ? 'it' : 'them') + '. Remote control left on for a contractor is a common way in.',
        fix: 'Turn off what nobody uses. Keep what the contractor needs reachable only from your VPN, with their own account.',
        devices: rd.map(function (d) { return d.id; }), tab: 'contractor',
      });
    }

    // Cameras on the payments network.
    var cams = shareWith(devices.filter(function (d) { return R(d) === 'camera'; }), posNets);
    if (cams.length) out.push({
      id: 'cameras-on-pos', severity: 'medium',
      title: plural(cams.length, 'camera or recorder', 'cameras and recorders') + ' share the network with your tills',
      detail: 'Cameras are among the most attacked devices on the internet, and many never get an update. They also send a lot of video across the network the tills use.',
      fix: 'Give cameras their own zone. Cameras talk to the recorder; one office PC views it.',
      devices: cams.map(function (d) { return d.id; }), tab: 'plan',
    });

    // Admin pages over plain HTTP.
    var http = devices.filter(function (d) {
      var role = R(d);
      if (!(ROLES[role].ot || role === 'network' || role === 'camera')) return false;
      return httpOnly(d);
    });
    if (http.length) out.push({
      id: 'http-admin', severity: 'medium',
      title: plural(http.length, 'device has', 'devices have') + ' an admin page over plain HTTP only',
      detail: 'The login and every setting travel unencrypted. On a shared network anyone can read the password.',
      fix: 'Turn on HTTPS if the device offers it, and keep the page reachable only from the zone that manages it.',
      devices: http.map(function (d) { return d.id; }), tab: 'devices',
    });

    // Factory-default names.
    var defaults = devices.filter(function (d) {
      return d.hostnames.some(function (h) { return MODEL_RULES.some(function (r) { return r[3] === 'd' && r[0].test(h); }); });
    });
    if (defaults.length) out.push({
      id: 'default-names', severity: 'low',
      title: plural(defaults.length, 'device still uses its', 'devices still use their') + ' factory name',
      detail: 'A device still called by its model name was probably set up with the factory defaults - often including the password.',
      fix: 'Ask the contractor to confirm the default passwords were changed (the checklist asks), and give the devices names that say where they are.',
      devices: defaults.map(function (d) { return d.id; }), tab: 'contractor',
    });

    // Unknowns.
    var unk = devices.filter(function (d) { return R(d) === 'unknown'; });
    if (unk.length) out.push({
      id: 'unknowns', severity: 'low',
      title: plural(unk.length, 'device', 'devices') + ' could not be identified',
      detail: 'Until you know what ' + (unk.length === 1 ? 'it is, it' : 'they are, they') + ' go' + (unk.length === 1 ? 'es' : '') + ' in the Guest zone: internet only. Find ' + (unk.length === 1 ? 'it' : 'them') + ' by address on the switch, or ask AI for a guess from the vendor and ports.',
      fix: 'Open each one and set what it is - the plan updates. Or use \u201cHelp me identify\u201d.',
      devices: unk.map(function (d) { return d.id; }), tab: 'devices',
    });

    if (!pos.length && devices.length) out.push({
      id: 'no-pos', severity: 'info',
      title: 'No tills or card readers were found',
      detail: 'If you take cards, check the device list: a till found under another role can be set by hand. Many card readers answer no ports at all, so they show up only in an ARP table or DHCP list.',
      fix: 'Add the router\u2019s DHCP lease list, or set the tills by hand.',
      devices: [], tab: 'devices',
    });

    var flatPos = posNets.filter(function (n) { return (net[n] || []).some(function (d) { return R(d) !== 'pos' && R(d) !== 'network'; }); });
    if (flatPos.length) out.push({
      id: 'pci-scope', severity: 'info',
      title: 'Card-payment rules (PCI DSS) probably cover this whole network',
      detail: 'When card terminals share a flat network with everything else, every device on it can be counted as in scope for the card-security rules - the cameras, the controllers, the guest phones. Separating payments is the usual way to shrink that. This is a plain-words summary, not legal or compliance advice: check with your card processor (acquirer) or a QSA.',
      fix: 'The Payments zone in the plan keeps the tills apart. Ask your processor what they need you to show.',
      devices: [], tab: 'plan',
    });

    if (pos.length && ot.length && !otPos.length) out.push({
      id: 'separate', severity: 'info',
      title: 'Your building devices are already on a different network from your tills',
      detail: 'Good. Check that the firewall between them blocks traffic both ways - being on different subnets alone does not.',
      fix: 'Compare your firewall rules with the rule table in the plan.',
      devices: [], tab: 'plan',
    });

    out.forEach(function (f) { f.rank = SEVERITY[f.severity].rank; f.order = FINDING_ORDER.indexOf(f.id); });
    out.sort(function (a, b) { return b.rank - a.rank || a.order - b.order; });
    return out;
  }

  /* ---------------- the zone plan and the rules ---------------- */

  function servicesOf(list, filter) {
    var m = {};
    list.forEach(function (d) {
      openPorts(d).forEach(function (p) {
        var k = p.port + '/' + p.proto;
        if (filter && !filter(p, k)) return;
        (m[k] = m[k] || { port: p.port, proto: p.proto, label: portLabel(p), devices: [] }).devices.push(d.id);
      });
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return a.port - b.port; });
  }
  function portText(s) { return s.label + ' ' + s.port + '/' + s.proto; }
  /** The ports the building controllers need from the BMS PC and the
   *  contractor: what they answered on, minus plain-text logins and remote
   *  control (which the plan asks to switch off). */
  function otServices(devices) {
    var ctl = devices.filter(function (d) { var r = d.cls.role; return CONTROLLERS.indexOf(r) !== -1 || r === 'bms'; });
    return servicesOf(ctl, function (p, k) { return !CLEAR_PORTS[k] && !REMOTE_PORTS[k] && [135, 139, 445, 53].indexOf(p.port) === -1; });
  }

  function zonePlan(devices) {
    var scheme = subnetScheme(devices);
    var zones = {};
    ZONE_ORDER.forEach(function (z) { zones[z] = { id: z, name: ZONES[z].name, icon: ZONES[z].icon, vlan: ZONES[z].vlan, subnet: scheme + '.' + ZONES[z].vlan + '.0/24', gateway: scheme + '.' + ZONES[z].vlan + '.1', purpose: ZONES[z].purpose, devices: [] }; });
    devices.forEach(function (d) { var z = ROLES[d.cls.role].zone; d.zone = z; zones[z].devices.push(d.id); });
    var list = ZONE_ORDER.map(function (z) { return zones[z]; }).filter(function (z) { return z.devices.length || z.id === 'mgmt'; });
    return { scheme: scheme, zones: list, byId: zones };
  }

  /** The firewall rules between zones: default deny, then the specific allows
   *  each zone needs. Nothing from Building & OT to Payments, ever. */
  function firewallRules(plan, devices) {
    var has = function (z) { return plan.byId[z] && plan.byId[z].devices.length; };
    var Z = function (z) { return ZONES[z].name; };
    var rules = [];
    var r = function (from, to, service, action, why) { rules.push({ from: from, to: to, service: service, action: action, why: why }); };
    var otsv = otServices(devices);
    var otPorts = otsv.length ? andList(otsv.map(portText)) : 'the ports the controllers use (none were seen - ask the contractor)';
    var bms = devices.filter(function (d) { return d.cls.role === 'bms'; });
    if (has('payments')) {
      r(Z('payments'), 'Internet', 'HTTPS 443 to your card processor and POS vendor only', 'Allow', 'Card terminals talk to the processor and nothing else. Ask the processor or POS vendor for the exact addresses.');
      r(Z('payments'), 'Firewall', 'DNS 53, NTP 123, DHCP', 'Allow', 'Names, the time and an address.');
      if (has('office')) r(Z('office'), Z('payments'), '-', 'Deny', 'Office PCs browse the web and open email - the usual way in. If your back-office PC runs the POS software, allow only the ports your POS vendor names, from that one PC.');
    }
    if (has('ot')) {
      r(Z('ot') + ' (BMS PC)', Z('ot') + ' (controllers)', otPorts, 'Allow (same zone)', 'The building-management PC reads and sets the controllers. Same zone, so no firewall rule is needed - just keep them together.');
      r('VPN (contractor)', Z('ot'), otPorts, 'Allow', 'The contractor\u2019s remote access, through your firewall\u2019s VPN, with their own login - switched on when they need it.');
      r(Z('ot'), 'Internet', 'HTTPS 443 to the equipment makers\u2019 cloud only', 'Allow', 'Some controllers report alarms and energy data to their maker. Ask the contractor for the addresses; block the rest.');
      if (has('office')) r(Z('office') + ' (one named PC)', Z('ot'), (bms.length ? 'HTTPS 443 to the BMS PC' : 'HTTPS 443 to the controllers\u2019 web pages'), 'Allow', 'Only if someone in the office checks temperatures or alarms. Name the PC; leave the rest of the office out.');
      r(Z('ot'), Z('payments'), '-', 'Deny', 'Never. A refrigeration or HVAC controller has no reason to reach a till.');
      r(Z('ot'), Z('office'), '-', 'Deny', 'Controllers do not start conversations with office PCs.');
    }
    if (has('cameras')) {
      r(Z('office') + ' (manager PC)', Z('cameras') + ' (recorder)', 'HTTPS 443 (and RTSP 554 for a viewer app)', 'Allow', 'One PC watches the recorder. Cameras themselves need no visitors.');
      r(Z('cameras'), 'Internet', '-', 'Deny', 'Unless you view cameras from your phone through the maker\u2019s app - then allow the recorder only, HTTPS 443.');
    }
    if (has('office')) r(Z('office'), 'Internet', 'Web and email', 'Allow', 'What the office needs. Your firewall\u2019s web filtering, if it has it, belongs here.');
    if (has('guest')) {
      r(Z('guest'), 'Internet', 'Web', 'Allow', 'Internet only. Turn on client isolation so guests cannot see each other.');
      r(Z('guest'), 'Every other zone', '-', 'Deny', 'Guests, staff phones and unidentified devices reach nothing of yours.');
    }
    r(Z('office') + ' (your admin PC)', Z('mgmt'), 'HTTPS 443, SSH 22', 'Allow', 'Switch, access-point and firewall admin pages, from one PC.');
    r('Any zone', 'Any other zone', 'Everything not listed above', 'Deny', 'Default deny. Log what is blocked for the first two weeks to catch anything the plan missed.');
    return rules;
  }

  /** How to build it, by kind of gear. Deliberately general: menu names vary
   *  by version, and the page says so. */
  var STEPS = {
    order: [
      'Do it out of hours, with the contractor reachable by phone - and test a refrigeration alarm before and after.',
      'Back up the firewall and switch settings, and write down how things are plugged in.',
      'Create the VLANs and their subnets on the firewall, each with its own DHCP range (or static addresses for controllers - ask the contractor which).',
      'Add the rules between zones, starting with default deny and the allows from the table. Log what is blocked.',
      'Move one zone at a time, least risky first: Guest Wi-Fi, then cameras, then building & OT, then payments. Check each before the next.',
      'Change the controllers\u2019 addresses only with the contractor: many are set by hand and the BMS PC looks for them by address.',
      'Watch the blocked-traffic log for two weeks, and allow only what you can explain.',
    ],
    gear: [
      { id: 'generic', name: 'Any managed switch + firewall', steps: ['Switch: create the VLANs by number (20 Payments, 30 Building & OT, and so on).', 'Set each port a device plugs into as an access (untagged) port in its VLAN.', 'Set the port to the firewall as a trunk carrying all the VLANs (tagged).', 'Firewall: one interface (or sub-interface) per VLAN with its gateway address and DHCP.', 'Write the rules per interface, default deny, then the allows from the table.', 'Wi-Fi: one network name (SSID) per zone that needs Wi-Fi, each tagged with its VLAN - Guest at least.'] },
      { id: 'unifi', name: 'UniFi', steps: ['Create a network for each zone with its VLAN ID and subnet.', 'Assign each switch port its network (the port\u2019s native or primary network).', 'Create the Guest Wi-Fi on the Guest network with client isolation.', 'Add firewall or traffic rules between the networks to match the table - or the network isolation setting for the simple cases.', 'Menu names vary by version and controller.'] },
      { id: 'meraki', name: 'Meraki', steps: ['On the MX: add a VLAN per zone with its subnet and DHCP.', 'On the switches: set ports as access ports in their VLAN, and the uplink as a trunk.', 'Add the layer 3 firewall rules on the MX to match the table.', 'Guest SSID: its own VLAN (or NAT mode) with client isolation.', 'Menu names vary by version.'] },
      { id: 'pfsense', name: 'pfSense / OPNsense', steps: ['Create the VLANs on the LAN port, then assign each as an interface with its gateway address.', 'Turn on DHCP per interface.', 'Firewall rules are written on the interface the traffic enters - a new interface blocks everything until you add a rule.', 'Add the allows from the table on each interface; leave the rest blocked.', 'Menu names vary by version.'] },
      { id: 'fortigate', name: 'FortiGate', steps: ['Create a VLAN interface per zone on the internal port, with its address and DHCP.', 'Write firewall policies between the interfaces to match the table; anything without a policy is denied.', 'Turn on logging for denied traffic while you settle in.', 'Menu names vary by version.'] },
    ],
  };

  /** The contractor checklist, with the ports this network\u2019s controllers use. */
  function checklist(devices) {
    var otsv = otServices(devices);
    var clear = devices.filter(function (d) { return ROLES[d.cls.role].ot && (openPorts(d).some(function (p) { return CLEAR_PORTS[p.port + '/' + p.proto]; }) || httpOnly(d)); });
    var remote = devices.filter(function (d) { return d.cls.role === 'remote'; });
    return [
      { id: 'inventory', text: 'A list of every device they installed: make, model, address, and what it controls. Compare it with this one.' },
      { id: 'paths', text: 'Every way in from outside: cellular modems' + (remote.length ? ' (we found ' + plural(remote.length, 'box', 'boxes') + ')' : '') + ', port forwards, VPNs, TeamViewer or VNC, cloud portals.' },
      { id: 'ports', text: 'Which ports their remote access really needs' + (otsv.length ? ' - we see ' + andList(otsv.map(portText)) : '') + ' - and to which devices.' },
      { id: 'passwords', text: 'Default passwords changed on every controller, and one login per technician - no shared accounts.' },
      { id: 'cleartext', text: 'Telnet, FTP and plain-HTTP admin pages turned off, in favour of SSH and HTTPS' + (clear.length ? ' (we found them on ' + plural(clear.length, 'device') + ')' : '') + '.' },
      { id: 'vpn', text: 'Remote access through your firewall\u2019s VPN only: their own account, switched on when they need it, logged.' },
      { id: 'modems', text: 'No new modem, router or Wi-Fi of their own without your written OK.' },
      { id: 'alarms', text: 'How temperature and equipment alarms reach them today - and a test alarm after every change, so a failing freezer is never missed.' },
      { id: 'cloud', text: 'The internet addresses their controllers report to, so the firewall can allow those and block the rest.' },
      { id: 'updates', text: 'When controller firmware was last updated, and who does it.' },
    ];
  }

  /** The letter to the HVAC / refrigeration contractor. Plain text, for an
   *  editable box: fields are cleaned to one line each. */
  function letter(devices, plan, fields) {
    var f = fields || {};
    var biz = clean(f.business, 80) || 'our store';
    var you = clean(f.you, 80) || '[Your name]';
    var who = clean(f.contractor, 80) || 'there';
    var when = clean(f.when, 80) || 'out of hours, on a date that suits you';
    var ot = devices.filter(function (d) { return ROLES[d.cls.role].ot && d.cls.role !== 'iot'; });
    var otsv = otServices(devices);
    var remote = devices.filter(function (d) { return d.cls.role === 'remote'; });
    var clearDevs = devices.filter(function (d) { return ROLES[d.cls.role].ot && openPorts(d).some(function (p) { return CLEAR_PORTS[p.port + '/' + p.proto]; }); });
    var otz = plan.byId.ot;
    var lines = [];
    lines.push('Hello ' + who + ',', '');
    lines.push('We are separating the network at ' + biz + ' so the building and refrigeration equipment you look after sits on its own network, away from our tills, office PCs and guest Wi-Fi. Nothing about how the equipment works should change, but how you reach it will, and we would like to plan it with you.', '');
    lines.push('What we are changing');
    lines.push('- The controllers below move to a separate network for building equipment (VLAN ' + otz.vlan + ', ' + otz.subnet + ').');
    lines.push('- That network can reach the internet only at the addresses you give us, and cannot reach our payment devices at all.');
    lines.push('- Remote access will come through our firewall\u2019s VPN, with a login for you, switched on when you need it.');
    lines.push('');
    if (ot.length) {
      lines.push('The equipment we found (please correct anything wrong)');
      ot.forEach(function (d) {
        var ps = openPorts(d).map(function (p) { return p.port + '/' + p.proto; });
        lines.push('- ' + clean(displayName(d), 60) + ' at ' + (d.ip || 'unknown address') + (d.vendor ? ', ' + clean(d.vendor, 60) : '') + ' (' + lowerLabel(d.cls.role) + ')' + (ps.length ? ', answering on ' + ps.join(', ') : ''));
      });
      lines.push('');
    }
    lines.push('What we will allow through the VPN');
    lines.push(otsv.length ? '- ' + otsv.map(portText).join('\n- ') : '- The ports you tell us the equipment needs.');
    lines.push('Please tell us if your tools need anything else, and to which device.', '');
    if (remote.length) {
      lines.push('Your remote-access ' + (remote.length === 1 ? 'box' : 'boxes'));
      remote.forEach(function (d) { lines.push('- ' + clean(displayName(d), 60) + ' at ' + (d.ip || 'unknown address') + (d.vendor ? ' (' + clean(d.vendor, 60) + ')' : '')); });
      lines.push('Once the VPN works for you we would like to unplug ' + (remote.length === 1 ? 'it' : 'them') + '. Please list any port forwards or other access set up on ' + (remote.length === 1 ? 'it' : 'them') + ', and do not install another modem or router without asking us first.', '');
    }
    if (clearDevs.length) {
      lines.push('Telnet and plain-text logins');
      lines.push('We found Telnet or FTP open on ' + andList(clearDevs.map(function (d) { return clean(displayName(d), 40) + ' (' + d.ip + ')'; })) + '. Could you switch them off, or tell us why they are needed?', '');
    }
    lines.push('Could you also send us');
    lines.push('- the list of everything you installed, with make, model and address;');
    lines.push('- confirmation that factory-default passwords have been changed;');
    lines.push('- how temperature and equipment alarms reach you, so we can test one after the change;');
    lines.push('- the internet addresses the controllers report to.', '');
    lines.push('We would like to make the change ' + when + ', with you available by phone in case anything needs a hand.', '');
    lines.push('Thank you,', you, biz === 'our store' ? '' : biz);
    return lines.join('\n').replace(/\n+$/, '') + '\n';
  }

  /* ---------------- the whole analysis ---------------- */

  /** Inputs (each from readInput) -> devices with roles, findings, verdict,
   *  plan and rules. `overrides` maps a device id to a role. */
  function analyse(inputs, opts) {
    var o = opts || {};
    var ov = o.overrides || {};
    var m = merge(inputs);
    var devices = m.devices;
    devices.forEach(function (d) { d.cls = classify(d, ov[d.id]); d.name = displayName(d); });
    var fs = findings(devices, m.cidrs);
    var byDev = {};
    fs.forEach(function (f) { f.devices.forEach(function (id) { (byDev[id] = byDev[id] || []).push(f.id); }); });
    devices.forEach(function (d) { d.findings = byDev[d.id] || []; });
    var plan = zonePlan(devices);
    var rules = firewallRules(plan, devices);
    var stats = { devices: devices.length, byRole: {} };
    ROLE_KEYS.forEach(function (k) { stats.byRole[k] = 0; });
    devices.forEach(function (d) { stats.byRole[d.cls.role]++; });
    stats.ot = devices.filter(function (d) { return ROLES[d.cls.role].ot; }).length;
    stats.networks = uniq(devices.map(function (d) { return d.net; })).filter(function (n) { return n !== 'unknown'; });
    var notes = [];
    (inputs || []).forEach(function (inp) { (inp.notes || []).forEach(function (n) { notes.push(clean(inp.name, 60) + ': ' + n); }); });
    m.notes.forEach(function (n) { notes.push(n); });
    var a = { devices: devices, byId: {}, findings: fs, plan: plan, rules: rules, stats: stats, notes: notes, cidrs: m.cidrs, inputs: (inputs || []).map(function (i) { return { name: i.name, kind: i.kind, label: i.label, devices: (i.devices || []).length, down: i.down || 0 }; }) };
    devices.forEach(function (d) { a.byId[d.id] = d; });
    a.verdict = verdict(a);
    return a;
  }

  function verdict(a) {
    var f0 = a.findings[0];
    var nets = a.stats.networks;
    var flat = nets.length === 1;
    var sub = plural(a.stats.devices, 'device') + ' on ' + (flat ? 'one flat network, ' + nets[0] : plural(nets.length, 'network'));
    if (!a.stats.devices) return { tone: 'empty', headline: 'No devices were found in these files.', sub: 'Check the file is a scan of your network, or add another.' };
    if (f0 && f0.id === 'ot-with-pos') return { tone: 'risk', headline: f0.title + ' - anyone who gets into one can reach the others.', sub: sub };
    var high = a.findings.filter(function (f) { return f.severity === 'high'; });
    if (high.length) return { tone: 'risk', headline: high[0].title + '.', sub: sub };
    var med = a.findings.filter(function (f) { return f.severity === 'medium'; });
    if (med.length) return { tone: 'check', headline: med[0].title + '.', sub: sub };
    if (a.stats.ot) return { tone: 'ok', headline: 'No building devices share a network with your tills or office.', sub: sub };
    return { tone: 'ok', headline: 'No building or refrigeration controllers were found.', sub: sub + '. If you have them, they may be on another network, or answering no ports - add the router\u2019s DHCP list.' };
  }

  /* ---------------- exports ---------------- */

  function evidenceTexts(d) { return evidenceByRole(d.cls).filter(function (g) { return g.role === d.cls.role; }).map(function (g) { return g.items.map(function (e) { return e.text; }); })[0] || []; }
  function confWord(c) { return CONF[c] || c; }

  /** The report for a manager or an auditor. Every string from a device is
   *  escaped for Markdown; nothing here is a link. */
  function toMarkdown(a, extra) {
    var x = extra || {};
    var o = [];
    o.push('# Zoned network report' + (x.title ? ' - ' + mdText(x.title) : ''), '');
    o.push('_' + mdText(x.date || '') + ' · read from ' + mdText(a.inputs.map(function (i) { return i.name + ' (' + i.label + ')'; }).join(', ')) + '. Zoned reads scans you already ran; it never scans anything itself._', '');
    o.push('## Verdict', '', '**' + mdText(a.verdict.headline) + '**', '', mdText(a.verdict.sub), '');
    o.push('## Findings', '');
    if (!a.findings.length) o.push('Nothing to report.', '');
    a.findings.forEach(function (f, i) {
      o.push((i + 1) + '. **' + SEVERITY[f.severity].word + ': ' + mdText(f.title) + '**  ', '   ' + mdText(f.detail) + '  ', '   _Fix:_ ' + mdText(f.fix));
      if (f.devices.length) o.push('   Devices: ' + f.devices.map(function (id) { var d = a.byId[id]; return mdCode(d.ip || d.mac) + ' ' + mdText(d.name); }).join(', '));
      o.push('');
    });
    o.push('## Proposed zones', '', '| Zone | VLAN | Subnet | Devices |', '| --- | --- | --- | --- |');
    a.plan.zones.forEach(function (z) { o.push('| ' + mdText(z.name) + ' | ' + z.vlan + ' | ' + mdCode(z.subnet) + ' | ' + z.devices.length + ' |'); });
    o.push('', '## Firewall rules between zones', '', '| # | From | To | Service | Action | Why |', '| --- | --- | --- | --- | --- | --- |');
    a.rules.forEach(function (r, i) { o.push('| ' + (i + 1) + ' | ' + mdText(r.from) + ' | ' + mdText(r.to) + ' | ' + mdText(r.service) + ' | ' + mdText(r.action) + ' | ' + mdText(r.why) + ' |'); });
    o.push('', '## Devices', '', '| IP | MAC | Vendor | Name | Role | Confidence | Zone | Why |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    a.devices.forEach(function (d) {
      var why = d.cls.overridden ? 'Set by you' : evidenceTexts(d).slice(0, 3).join('; ');
      o.push('| ' + mdCode(d.ip || '-') + ' | ' + mdCode(d.mac || '-') + ' | ' + mdText(d.vendor || '-') + ' | ' + mdText(d.name) + ' | ' + mdText(ROLES[d.cls.role].label) + ' | ' + mdText(confWord(d.cls.conf)) + ' | ' + mdText(ZONES[d.zone].name) + ' | ' + mdText(why || '-') + ' |');
    });
    var notes = x.notes || {};
    var noted = a.devices.filter(function (d) { return notes[d.id]; });
    if (noted.length) { o.push('', '## Your notes', ''); noted.forEach(function (d) { o.push('- ' + mdCode(d.ip || d.mac) + ' ' + mdText(d.name) + ': ' + mdText(clean(notes[d.id], LIMITS.noteLen))); }); }
    o.push('', '---', '', '_Card-payment scope (PCI DSS) depends on your processor and assessor - this report is not legal or compliance advice._', '');
    return o.join('\n');
  }
  function toJson(a, extra) {
    var x = extra || {};
    var notes = x.notes || {};
    return JSON.stringify({
      tool: 'Zoned', generated: x.date || '', inputs: a.inputs,
      verdict: { headline: a.verdict.headline, detail: a.verdict.sub },
      devices: a.devices.map(function (d) {
        return {
          ip: d.ip || null, mac: d.mac || null, vendor: d.vendor || null, hostnames: d.hostnames, name: d.name,
          role: d.cls.role, roleLabel: ROLES[d.cls.role].label, confidence: d.cls.conf, setByYou: Boolean(d.cls.overridden),
          evidence: d.cls.evidence.map(function (e) { return { role: e.role, weight: e.w, text: e.text }; }),
          ports: openPorts(d).map(function (p) { return { port: p.port, proto: p.proto, service: p.service || null, label: portLabel(p) }; }),
          zone: d.zone, findings: d.findings, note: notes[d.id] ? clean(notes[d.id], LIMITS.noteLen) : undefined, sources: d.sources,
        };
      }),
      findings: a.findings.map(function (f) { return { id: f.id, severity: f.severity, title: f.title, detail: f.detail, fix: f.fix, devices: f.devices.map(function (id) { return a.byId[id].ip || a.byId[id].mac; }) }; }),
      plan: { zones: a.plan.zones.map(function (z) { return { name: z.name, vlan: z.vlan, subnet: z.subnet, gateway: z.gateway, devices: z.devices.map(function (id) { return a.byId[id].ip || a.byId[id].mac; }) }; }), rules: a.rules },
    }, null, 2);
  }

  /* ---------------- the one model call ---------------- */

  var ADDR_RE = /\b\d{1,3}(?:[.\-_]\d{1,3}){3}\b|\b[0-9a-fA-F]{1,2}(?:[:\-][0-9a-fA-F]{1,2}){5}\b|\b[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\b|\b[0-9a-fA-F]{12}\b|\b[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}\b/g;
  /** No addresses leave the device: anything shaped like an IPv4, IPv6 or
   *  MAC address is replaced before a string is sent. */
  function scrub(s, max) { return clean(String(s || '').replace(ADDR_RE, '[address]'), max || LIMITS.identifyStr); }
  /** What "Help me identify" sends for the chosen devices: a reference, the
   *  vendor name, hostnames and what answered on which port. No IP, no MAC. */
  function identifyPayload(a, ids) {
    var refs = {}, list = [];
    (ids || []).slice(0, LIMITS.identifyDevices).forEach(function (id, i) {
      var d = a.byId[id];
      if (!d) return;
      var ref = 'd' + (i + 1);
      refs[ref] = id;
      list.push({
        ref: ref,
        vendor: scrub(d.vendor),
        hostnames: d.hostnames.map(function (h) { return scrub(h); }).filter(function (h) { return h && h !== '[address]'; }).slice(0, 3),
        services: openPorts(d).slice(0, LIMITS.identifyServices).map(function (p) { return { port: p.port, proto: p.proto, service: scrub(p.service, 40), product: scrub([p.product, p.version, p.extrainfo].filter(Boolean).join(' ')), title: scrub(p.title || p.banner) }; }),
        os: d.os ? scrub(d.os.name, 80) : '',
        privateAddress: Boolean(d.randomMac),
      });
    });
    return { body: { devices: list }, refs: refs };
  }
  /** The request, rebuilt field by field (the server runs this too): only
   *  those fields, in those shapes, scrubbed of addresses again. */
  function cleanIdentifyRequest(v) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.devices) || !v.devices.length || v.devices.length > LIMITS.identifyDevices) return null;
    var seen = {}, out = [];
    for (var i = 0; i < v.devices.length; i++) {
      var d = v.devices[i];
      if (!d || typeof d !== 'object' || typeof d.ref !== 'string' || !/^d\d{1,2}$/.test(d.ref) || seen[d.ref]) return null;
      seen[d.ref] = 1;
      var services = Array.isArray(d.services) ? d.services.slice(0, LIMITS.identifyServices).filter(function (p) { return p && typeof p === 'object' && Number.isInteger(p.port) && p.port > 0 && p.port < 65536; }).map(function (p) {
        return { port: p.port, proto: /^(tcp|udp|sctp)$/.test(p.proto) ? p.proto : 'tcp', service: scrub(p.service, 40), product: scrub(p.product), title: scrub(p.title) };
      }) : [];
      var hostnames = Array.isArray(d.hostnames) ? d.hostnames.slice(0, 3).filter(function (h) { return typeof h === 'string'; }).map(function (h) { return scrub(h); }).filter(function (h) { return h && h !== '[address]'; }) : [];
      out.push({ ref: d.ref, vendor: typeof d.vendor === 'string' ? scrub(d.vendor) : '', hostnames: hostnames, services: services, os: typeof d.os === 'string' ? scrub(d.os, 80) : '', privateAddress: d.privateAddress === true });
    }
    // A device with nothing to go on is not worth a token.
    out = out.filter(function (d) { return d.vendor || d.hostnames.length || d.services.length || d.os; });
    if (!out.length) return null;
    return { devices: out };
  }
  /** The model's answer, checked: a ref that was sent, a role from the fixed
   *  list, a confidence word, and two bounded sentences with no markup. */
  function cleanIdentification(raw, refs) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.devices)) return null;
    var allowed = refs || null, seen = {}, out = [];
    raw.devices.slice(0, 40).forEach(function (x) {
      if (!x || typeof x !== 'object' || typeof x.ref !== 'string') return;
      if (allowed && !Object.prototype.hasOwnProperty.call(allowed, x.ref)) return;
      if (seen[x.ref] || !ROLES[x.role]) return;
      var conf = ['high', 'medium', 'low'].indexOf(x.confidence) !== -1 ? x.confidence : 'low';
      var why = clean(String(x.why || '').replace(/[<>]/g, ''), 400), check = clean(String(x.check || '').replace(/[<>]/g, ''), 400);
      if (!why) return;
      seen[x.ref] = 1;
      out.push({ ref: x.ref, role: x.role, confidence: conf, why: why, check: check });
    });
    return out.length ? { devices: out } : null;
  }

  return {
    LIMITS: LIMITS, ROLES: ROLE_KEYS.reduce(function (o, k) { o[k] = ROLES[k]; return o; }, {}), ROLE_KEYS: ROLE_KEYS, ZONES: ZONES, ZONE_ORDER: ZONE_ORDER, SEVERITY: SEVERITY, CONF: CONF, PORTS: PORTS,
    OT_PORTS: OT_PORTS, TCP_PORTS: TCP_PORTS, UDP_PORTS: UDP_PORTS, STEPS: STEPS, VENDOR_RULES: VENDOR_RULES, MODEL_RULES: MODEL_RULES,
    clean: clean, esc: esc, fmtInt: fmtInt, plural: plural, andList: andList, cap: cap, hashText: hashText, mdText: mdText, mdCode: mdCode,
    isIPv4: isIPv4, ipNum: ipNum, normMac: normMac, randomMac: randomMac, multicastMac: multicastMac, parseCidr: parseCidr,
    gatherCommands: gatherCommands, xmlWalk: xmlWalk, decodeXml: decodeXml,
    parseNmapXml: parseNmapXml, parseNmapNormal: parseNmapNormal, parseGrepable: parseGrepable, parseArp: parseArp, parseCsv: parseCsv,
    automapLeases: automapLeases, parseLeases: parseLeases, parseDnsmasq: parseDnsmasq, detectKind: detectKind, readInput: readInput,
    merge: merge, evidence: evidence, classify: classify, evidenceByRole: evidenceByRole, displayName: displayName, openPorts: openPorts, portLabel: portLabel,
    networkOf: networkOf, findings: findings, zonePlan: zonePlan, firewallRules: firewallRules, otServices: otServices, checklist: checklist, letter: letter,
    analyse: analyse, lowerLabel: lowerLabel, httpOnly: httpOnly, toMarkdown: toMarkdown, toJson: toJson, confWord: confWord, evidenceTexts: evidenceTexts,
    scrub: scrub, identifyPayload: identifyPayload, cleanIdentifyRequest: cleanIdentifyRequest, cleanIdentification: cleanIdentification,
  };
}));
