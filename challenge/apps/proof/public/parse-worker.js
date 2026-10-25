/* Proof - the parse worker. A Claude Code transcript can run to tens of
 * megabytes, so reading it runs off the page and never freezes it. Nothing
 * here makes a request: the rules are ProofCore's, and the bytes come from
 * what the page hands in.
 *
 * Messages in:  {op:'file', id, name, bytes:ArrayBuffer}
 *               {op:'text', id, name, text, summary}
 * Messages out: {op:'progress', id, phase}
 *               {op:'run', id, run}
 *               {op:'error', id, message}
 */
/* global importScripts */
importScripts('proof-core.js');
var C = self.ProofCore;

function post(m) { self.postMessage(m); }

function looksBinary(text) {
  var sample = text.slice(0, 8000);
  if (!sample) return false;
  var bad = 0;
  for (var i = 0; i < sample.length; i++) { var c = sample.charCodeAt(i); if (c === 0 || c === 0xFFFD) bad++; }
  return bad > sample.length * 0.02;
}

function finish(id, text, opts) {
  if (looksBinary(text)) { post({ op: 'error', id: id, message: 'That looks like a binary file, not a run. Drop a .jsonl, .json, .txt or .log, or paste the terminal output.' }); return; }
  post({ op: 'progress', id: id, phase: 'parse' });
  var run = C.parseRun(text, opts);
  if (run.error) { post({ op: 'error', id: id, message: run.error }); return; }
  post({ op: 'run', id: id, run: run });
}

self.onmessage = function (ev) {
  var m = ev.data || {};
  var id = m.id;
  try {
    if (m.op === 'file') {
      var bytes = new Uint8Array(m.bytes);
      if (bytes.length > C.LIMITS.inputBytes) { post({ op: 'error', id: id, message: 'That file is over ' + C.fmtBytes(C.LIMITS.inputBytes) + '. Drop one session’s transcript, not a folder of them.' }); return; }
      post({ op: 'progress', id: id, phase: 'read' });
      finish(id, new TextDecoder('utf-8', { fatal: false }).decode(bytes), { name: m.name || '' });
      return;
    }
    if (m.op === 'text') { finish(id, String(m.text || ''), { name: m.name || '', summary: m.summary || '' }); return; }
    post({ op: 'error', id: id, message: 'Unknown request.' });
  } catch (e) {
    post({ op: 'error', id: id, message: 'That could not be read: ' + String(e && e.message || e).slice(0, 200) });
  }
};
