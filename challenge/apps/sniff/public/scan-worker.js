/* Sniff - the scanner's worker. A folder (many files), a .zip, .crx, .tgz or
 * .tar.gz can be large and a scan can be heavy, so it runs off the page and
 * never freezes it. Nothing here makes a request: all the rules are
 * SniffCore's, and the files are read from what the page hands in.
 *
 * Messages in:  {op:'files', id, files:[{path, bytes:ArrayBuffer}]}
 *               {op:'archive', id, name, bytes:ArrayBuffer}
 *               {op:'paste', id, text}
 *               {op:'demo', id, which:'weather'|'tidy', entries:[{path,text}]}
 * Messages out: {op:'progress', id, done, total, phase}
 *               {op:'report', id, report}
 *               {op:'error', id, message}
 */
/* global importScripts, SniffCore */
importScripts('sniff-core.js');
var C = self.SniffCore;

function post(m) { self.postMessage(m); }
var enc = new TextEncoder();

/** Entries with a `read(max)` from in-memory byte buffers. */
function entriesFromFiles(files) {
  return files.map(function (f) {
    var u = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    return { path: f.path, size: u.length, read: function (max) { return Promise.resolve({ bytes: u.subarray(0, max), cut: u.length > max }); } };
  });
}
function entriesFromText(entries) {
  return entries.map(function (e) {
    var u = enc.encode(e.text);
    return { path: e.path, size: u.length, read: function (max) { return Promise.resolve({ bytes: u.subarray(0, max), cut: u.length > max }); } };
  });
}

function finish(id, entries, preSkipped, meta0) {
  return C.collect(entries, preSkipped, function (done, total) { post({ op: 'progress', id: id, done: done, total: total, phase: 'read' }); }).then(function (c) {
    post({ op: 'progress', id: id, done: c.files.length, total: c.files.length, phase: 'rules' });
    var meta = Object.assign({ skipped: c.skipped, counts: c.counts, root: c.root, bytes: c.bytes }, meta0 || {});
    if (c.root) (meta.notes = meta.notes || []).push('Everything was inside one folder, ' + c.root + '/; its name is dropped from the paths below.');
    var report = C.scan(c.files, meta);
    // Only the files a finding points at - so Explain/Second-opinion can build
    // their snippet payloads on the page, without holding every file's text.
    var want = {};
    report.findings.forEach(function (f) {
      [f.file, f.source && f.source.file, f.sink && f.sink.file, f.handoff && f.handoff.file].forEach(function (x) { if (x) want[x] = 1; });
    });
    report.destinations.forEach(function (d) { (d.refs || []).forEach(function (r) { want[r.file] = 1; }); });
    var texts = {};
    c.files.forEach(function (f) { if (want[f.path]) texts[f.path] = f.text; });
    post({ op: 'report', id: id, report: report, texts: texts });
  });
}

self.onmessage = function (ev) {
  var m = ev.data || {};
  var id = m.id;
  try {
    if (m.op === 'files') {
      finish(id, entriesFromFiles(m.files), [], { name: m.name || '', source: 'files' }).catch(function (e) { post({ op: 'error', id: id, message: String(e && e.message || e) }); });
      return;
    }
    if (m.op === 'archive') {
      var bytes = new Uint8Array(m.bytes);
      post({ op: 'progress', id: id, done: 0, total: 0, phase: 'unpack' });
      C.openArchive(bytes, m.name).then(function (a) {
        if (!a) throw new Error('That did not look like a folder, a .zip, a .crx or a .tgz. Drop a folder, or paste the code.');
        return finish(id, a.entries, a.skipped, { name: m.name || '', source: a.kind, notes: a.notes });
      }).catch(function (e) { post({ op: 'error', id: id, message: String(e && e.message || e) }); });
      return;
    }
    if (m.op === 'paste') {
      var f = C.pastedFile(m.text || '');
      var report = C.scan([f], { name: 'Pasted code', source: 'paste' });
      var texts = {}; texts[f.path] = f.text;
      post({ op: 'report', id: id, report: report, texts: texts });
      return;
    }
    if (m.op === 'demo') {
      finish(id, entriesFromText(m.entries), [], { name: m.name || '', kind: 'extension', source: 'demo' }).catch(function (e) { post({ op: 'error', id: id, message: String(e && e.message || e) }); });
      return;
    }
    post({ op: 'error', id: id, message: 'Unknown request.' });
  } catch (e) {
    post({ op: 'error', id: id, message: String(e && e.message || e) });
  }
};
