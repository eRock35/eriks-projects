/* Zoned - the example: "Corner Market", a made-up grocery store whose
 * HVAC and refrigeration contractors plugged their controllers - and a
 * cellular modem - into the one flat network the tills, the office PC,
 * the cameras and the guest Wi-Fi share.
 *
 * It is written out as the exact files the commands on the page produce
 * (nmap -oX for TCP, a second -oX for the building UDP ports, and the
 * router's DHCP lease export) and read by the same parsers as a real scan.
 *
 * Every MAC address is from RFC 7042's documentation range
 * (00-00-5E-00-53-00 to -FF), so no real manufacturer's prefix is implied;
 * the vendor names are written the way nmap prints them. Phones use
 * private (locally administered) addresses, as phones do. All of it is
 * fictional, and none of it is saved.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZonedDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NET = '192.168.1.';
  function mac(n) { return '00:00:5E:00:53:' + ('0' + n.toString(16).toUpperCase()).slice(-2); }
  function x(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // [last octet, mac index, vendor, hostname, ports, os, devicetype]
  // ports: [port, service, product, extra (title)]
  var WIN = 'Microsoft Windows 10 1809 - 21H2';
  var SMB = [[135, 'msrpc', 'Microsoft Windows RPC'], [139, 'netbios-ssn', 'Microsoft Windows netbios-ssn'], [445, 'microsoft-ds', '']];
  var TCP = [
    [1, 1, 'Ubiquiti Networks', 'gateway.cornermarket.lan', [[22, 'ssh', 'OpenSSH 8.4p1'], [53, 'domain', 'dnsmasq 2.85'], [80, 'http', 'lighttpd'], [443, 'https', 'lighttpd']], 'Linux 4.15 - 5.8', 'router'],
    [2, 2, 'Cisco Systems', 'switch-backroom', [[22, 'ssh', 'Cisco SSH 1.25'], [80, 'http', 'Cisco SG350 switch http config']], '', 'switch'],
    [3, 3, 'Ubiquiti Networks', 'ap-salesfloor', [[22, 'ssh', 'Dropbear sshd 2019.78']], 'Linux 3.2 - 4.9', 'WAP'],
    [10, 10, 'Dell', 'BACKOFFICE-PC.cornermarket.lan', SMB.concat([[3389, 'ms-wbt-server', 'Microsoft Terminal Services']]), WIN, ''],
    [11, 11, 'Synology Incorporated', 'storenas', [[80, 'http', 'nginx', 'Synology DiskStation'], [443, 'https', 'nginx', 'Synology DiskStation'], [445, 'microsoft-ds', 'Samba smbd 4.6.2'], [5000, 'http', 'nginx'], [5001, 'https', 'nginx']], 'Linux 4.4', ''],
    [21, 21, 'NCR', 'till-01.cornermarket.lan', SMB, 'Microsoft Windows 10 IoT Enterprise', ''],
    [22, 22, 'NCR', 'till-02.cornermarket.lan', SMB, 'Microsoft Windows 10 IoT Enterprise', ''],
    [23, 23, 'NCR', 'till-03.cornermarket.lan', SMB, 'Microsoft Windows 10 IoT Enterprise', ''],
    [24, 24, 'NCR', 'till-04.cornermarket.lan', SMB, 'Microsoft Windows 10 IoT Enterprise', ''],
    [25, 25, 'Verifone', 'pinpad-01', [], '', ''],
    [30, 30, 'Hewlett Packard', 'HP-LaserJet-M404', [[80, 'http', 'HP LaserJet http config', 'HP LaserJet M404dn'], [443, 'https', 'HP LaserJet http config'], [631, 'ipp', 'HP LaserJet ipp'], [9100, 'jetdirect', '']], '', 'printer'],
    [31, 31, 'Zebra Technologies', 'label-printer', [[80, 'http', 'Zebra ZD420 http config'], [9100, 'jetdirect', '']], '', 'printer'],
    [40, 40, 'Apple', 'Managers-iPhone', [], '', ''],
    [60, 60, 'Danfoss', 'AK-SM800', [[80, 'http', 'Danfoss AK-SM 800 web', 'Danfoss AK-SM 800 - Login'], [443, 'https', 'Danfoss AK-SM 800 web'], [502, 'mbap', 'Modbus TCP']], '', 'specialized'],
    [61, 61, 'Carel Industries', 'case-ctrl-dairy', [[80, 'http', 'Boa httpd', 'pCOWeb - Carel']], '', 'specialized'],
    [62, 62, 'Dixell', 'XWEB300D', [[23, 'telnet', 'BusyBox telnetd'], [80, 'http', 'lighttpd', 'XWEB300D - Dixell']], 'Linux 2.6.32', 'specialized'],
    [70, 70, 'Johnson Controls', 'rtu-1-ctrl', [[80, 'http', 'Microsoft IIS httpd', 'Metasys'], [443, 'https', 'Microsoft IIS httpd', 'Metasys']], '', 'specialized'],
    [75, 75, 'Dell', 'BMS-WS', SMB.concat([[3389, 'ms-wbt-server', 'Microsoft Terminal Services'], [4911, 'ssl/niagara-fox', 'Niagara Fox'], [5938, 'teamviewer', 'TeamViewer']]), WIN, ''],
    [80, 80, 'Lutron Electronics', 'lutron-qsx', [[23, 'telnet', 'Lutron integration telnet'], [80, 'http', 'Lutron QSX web']], '', 'specialized'],
    [90, 90, 'Sierra Wireless', 'airlink-lx40', [[22, 'ssh', 'Dropbear sshd'], [9443, 'https', 'ACEmanager', 'ACEmanager - ALEOS']], 'Linux 3.10', 'broadband router'],
    [95, 95, 'ecobee', 'ecobee-thermostat', [], '', ''],
    [100, 100, 'Hikvision Digital Technology', 'DS-7608NI-K2', [[80, 'http', 'Hikvision web', 'Index'], [554, 'rtsp', 'Hikvision 7513 POE IP camera rtspd'], [8000, 'http-alt', '']], 'Linux 3.2 - 4.9', 'webcam'],
    [101, 101, 'Hikvision Digital Technology', '', [[80, 'http', 'Hikvision web'], [443, 'https', 'Hikvision web'], [554, 'rtsp', 'Hikvision rtspd']], '', 'webcam'],
    [102, 102, 'Hikvision Digital Technology', '', [[80, 'http', 'Hikvision web'], [443, 'https', 'Hikvision web'], [554, 'rtsp', 'Hikvision rtspd']], '', 'webcam'],
    [103, 103, 'Hikvision Digital Technology', '', [[80, 'http', 'Hikvision web'], [443, 'https', 'Hikvision web'], [554, 'rtsp', 'Hikvision rtspd']], '', 'webcam'],
    [104, 104, 'Hikvision Digital Technology', '', [[80, 'http', 'Hikvision web'], [443, 'https', 'Hikvision web'], [554, 'rtsp', 'Hikvision rtspd']], '', 'webcam'],
    [105, 105, 'Hikvision Digital Technology', '', [[80, 'http', 'Hikvision web'], [443, 'https', 'Hikvision web'], [554, 'rtsp', 'Hikvision rtspd']], '', 'webcam'],
    [106, 106, 'Hikvision Digital Technology', '', [[80, 'http', 'Hikvision web'], [443, 'https', 'Hikvision web'], [554, 'rtsp', 'Hikvision rtspd']], '', 'webcam'],
    [107, 107, 'Zhejiang Dahua Technology', '', [[80, 'http', 'Dahua web'], [554, 'rtsp', 'Dahua rtspd'], [37777, 'unknown', '']], '', 'webcam'],
    [108, 108, 'Zhejiang Dahua Technology', '', [[80, 'http', 'Dahua web'], [554, 'rtsp', 'Dahua rtspd'], [37777, 'unknown', '']], '', 'webcam'],
    [150, 150, 'Shenzhen Bilian Electronic', '', [[80, 'http', 'GoAhead WebServer', 'Login']], '', ''],
    [151, 151, 'Private', '', [[10001, 'scp-config', '']], '', ''],
  ];
  var UDP = [[61, 61, 'Carel Industries', 47808], [70, 70, 'Johnson Controls', 47808]];
  var ARGS_TCP = 'nmap -sV -O --max-rate 200 -p T:1-1024,1883,1911,3389,4911,5900,5938,8000,8080,8443,8883,9100,9443,20000,37777,44818,47808 -oX store.xml 192.168.1.0/24';
  var ARGS_UDP = 'nmap -sU -sV --max-rate 100 -p U:47808,1628,1629,3671 -oX store-udp.xml 192.168.1.0/24';

  function hostXml(h, proto) {
    var o = ['<host starttime="1760000000" endtime="1760000060"><status state="up" reason="arp-response" reason_ttl="0"/>'];
    o.push('<address addr="' + NET + h[0] + '" addrtype="ipv4"/>');
    o.push('<address addr="' + mac(h[1]) + '" addrtype="mac" vendor="' + x(h[2]) + '"/>');
    o.push('<hostnames>' + (h[3] ? '<hostname name="' + x(h[3]) + '" type="PTR"/>' : '') + '</hostnames>');
    o.push('<ports><extraports state="closed" count="' + (proto === 'udp' ? 3 : 1030) + '"><extrareasons reason="resets" count="1030" proto="' + proto + '" ports="1-1024"/></extraports>');
    h[4].forEach(function (p) {
      var prod = p[2] ? ' product="' + x(p[2]) + '"' : '';
      o.push('<port protocol="' + proto + '" portid="' + p[0] + '"><state state="open" reason="syn-ack" reason_ttl="64"/><service name="' + x(p[1]) + '"' + prod + (h[6] ? ' devicetype="' + x(h[6]) + '"' : '') + ' method="probed" conf="10"/>' + (p[3] ? '<script id="http-title" output="' + x(p[3]) + '"><elem key="title">' + x(p[3]) + '</elem></script>' : '') + '</port>');
    });
    o.push('</ports>');
    if (h[5]) o.push('<os><portused state="open" proto="tcp" portid="22"/><osmatch name="' + x(h[5]) + '" accuracy="96" line="1"><osclass type="' + (/Windows/.test(h[5]) ? 'general purpose' : x(h[6] || 'general purpose')) + '" vendor="' + (/Windows/.test(h[5]) ? 'Microsoft' : 'Linux') + '" osfamily="' + (/Windows/.test(h[5]) ? 'Windows' : 'Linux') + '" accuracy="96"/></osmatch></os>');
    o.push('<times srtt="1200" rttvar="400" to="100000"/></host>');
    return o.join('\n');
  }
  function nmapXml(args, hosts, proto) {
    return ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE nmaprun>', '<?xml-stylesheet href="file:///usr/bin/../share/nmap/nmap.xsl" type="text/xsl"?>',
      '<!-- Nmap 7.95 scan initiated as: ' + x(args) + ' -->',
      '<nmaprun scanner="nmap" args="' + x(args) + '" start="1760000000" startstr="Sat Oct 11 21:00:00 2025" version="7.95" xmloutputversion="1.05">',
      '<scaninfo type="' + (proto === 'udp' ? 'udp' : 'syn') + '" protocol="' + proto + '" numservices="1040" services="' + (proto === 'udp' ? '1628-1629,3671,47808' : '1-1024') + '"/>',
      '<verbose level="0"/><debugging level="0"/>',
      hosts.map(function (h) { return hostXml(h, proto); }).join('\n'),
      '<runstats><finished time="1760001500" timestr="Sat Oct 11 21:25:00 2025" summary="Nmap done" elapsed="1500.00" exit="success"/><hosts up="' + hosts.length + '" down="' + (254 - hosts.length) + '" total="256"/></runstats>',
      '</nmaprun>', ''].join('\n');
  }

  // The router's DHCP lease list, exported to CSV. Its own odd headers;
  // MACs with dashes, upper case. Tills and the PIN pad again (merged by
  // MAC), the phones on the guest Wi-Fi - bridged into the same network -
  // and one device nothing else knows about.
  var PHONES = [
    ['iPhone', 'A6:3C:91:0E:5B:21', 120], ['Galaxy-S23', 'DA:A1:19:47:3E:02', 121], ['android-3f9c2a1b77e4', '5E:22:8B:C0:91:7D', 122],
    ['Pixel-8', '72:1F:E4:5A:09:B3', 123], ['Sarahs-iPhone', 'F2:6D:30:A8:17:C4', 124], ['MacBook-Air', '9A:44:C2:7E:5D:10', 125],
    ['iPad', '3A:B7:05:92:EE:61', 126], ['Mikes-Galaxy', 'C6:18:7A:3D:04:9F', 127], ['OnePlus-11', '0A:5B:E2:71:C8:36', 128],
    ['android-77b1e0c41d', 'BE:93:4F:0C:62:A5', 129], ['Pixel-7a', '7E:09:D1:B8:33:4A', 130], ['iPhone-2', 'E6:F0:28:5C:A1:7B', 131],
  ];
  function leasesCsv() {
    var rows = ['"Client Name","IPv4 Address","Hardware Addr","Lease Expires"'];
    [21, 22, 23, 24].forEach(function (n, i) { rows.push('"TILL-0' + (i + 1) + '","' + NET + n + '","' + mac(n).replace(/:/g, '-') + '","2025-10-12 21:00"'); });
    rows.push('"PINPAD-01","' + NET + '25","' + mac(25).replace(/:/g, '-') + '","2025-10-12 21:00"');
    PHONES.forEach(function (p) { rows.push('"' + p[0] + '","' + NET + p[2] + '","' + p[1].replace(/:/g, '-') + '","2025-10-12 21:00"'); });
    rows.push('"*","' + NET + '152","' + mac(152).replace(/:/g, '-') + '","2025-10-12 21:00"');
    return rows.join('\r\n') + '\r\n';
  }

  return {
    title: 'Corner Market',
    blurb: 'A made-up grocery store: one flat network, 192.168.1.0/24, with 45 devices.',
    cidr: '192.168.1.0/24',
    files: function () {
      return [
        { name: 'store.xml', text: nmapXml(ARGS_TCP, TCP, 'tcp') },
        { name: 'store-udp.xml', text: nmapXml(ARGS_UDP, UDP.map(function (u) { return [u[0], u[1], u[2], '', [[u[3], 'bacnet', 'BACnet']], '', '']; }), 'udp') },
        { name: 'leases.csv', text: leasesCsv() },
      ];
    },
    letterFields: { business: 'Corner Market', you: 'Dana Ruiz, Store IT', contractor: 'Northside Refrigeration & HVAC', when: 'Tuesday night after closing' },
    // What the example is built to show - asserted by test/run.js.
    planted: {
      devices: 45,
      findings: ['ot-with-pos', 'remote-gateway', 'open-ot-protocols', 'cleartext', 'guest-on-business', 'remote-desktop', 'cameras-on-pos', 'http-admin', 'default-names', 'unknowns', 'pci-scope'],
      headline: '4 refrigeration and HVAC controllers share a network with your 5 tills',
      roles: { pos: 5, refrigeration: 3, hvac: 1, bms: 1, lighting: 1, remote: 1, iot: 1, camera: 9, printer: 2, office: 2, network: 3, guest: 13, unknown: 3 },
      conflict: '192.168.1.75',  // the BMS PC: a Dell running Windows, and a Niagara supervisor
      telnet: ['192.168.1.62', '192.168.1.80'],
      otPorts: ['80/tcp', '443/tcp', '502/tcp', '4911/tcp', '47808/udp'],
    },
  };
}));
