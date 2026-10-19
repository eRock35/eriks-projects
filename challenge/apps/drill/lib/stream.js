// Long answers stream whitespace - trip-planner's streamedJson, copied.
//
// A deep read of a long text, or an originality check that searches the web,
// can take a minute or two, and nothing crosses the wire meanwhile. iOS
// Safari on a mobile network drops a connection that idle, so a working
// request looks like a broken app. This sends the headers and one space at
// once, then a space every five seconds until the body is ready. Leading
// whitespace is legal JSON, so the client still uses a plain res.json().
//
// THE CONTRACT: headers go out before the outcome is known, so a failure
// after this is called comes back as 200 with an {error} body, never a status.
// Everything that fails with a status - sign-in, budget, daily cap, a bad
// body - must run BEFORE it. The page and the extension check
// `!res.ok || data.error`.
//
// The heartbeat runs inside the open request and stops with it (the service
// is billed per request; nothing may run after a response).

const HEARTBEAT_MS = 5000;

function streamedJson(res) {
  res.status(200);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  const beat = () => { try { res.write(' '); } catch (e) { /* client went away */ } };
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  let done = false;
  res.on('close', () => clearInterval(timer));
  return function send(payload) {
    if (done) return;
    done = true;
    clearInterval(timer);
    try { res.end(JSON.stringify(payload)); } catch (e) { /* client went away */ }
  };
}

module.exports = { streamedJson, HEARTBEAT_MS };
