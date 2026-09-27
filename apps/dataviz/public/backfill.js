/* Stills for projects saved before stills existed (2026-09-27).
 *
 * A share link unfolds into its chart only once the owner's browser has drawn
 * and uploaded a still for it. New saves do that at once; older projects got
 * one only when their owner happened to reopen that one project, so their
 * links showed the generic card indefinitely. This fills them in quietly the
 * next time the owner opens the app.
 *
 * The rules, and why:
 *   - Owner's own projects only: it reads GET /api/projects, which is theirs,
 *     and uploads through PUT /api/projects/:id/still, so every server check
 *     (ownership, PNG/JPEG by bytes, exactly 1200x630, 400 KB) still applies.
 *   - One at a time, each after the page is idle, at most MAX_PER_VISIT: a
 *     redraw is a canvas render and an upload of up to 400 KB, and a person
 *     with sixty saved charts should not pay for all sixty on one visit.
 *   - Never on Save-Data / prefers-reduced-data, never while the tab is
 *     hidden, and it stops the moment the tab goes to the background.
 *   - A project that failed once this session is not retried until the next.
 *
 * Browser and CommonJS: `pick` is pure and `run` takes everything it touches
 * as arguments, so test/backfill.js exercises the real code.
 */
(function (root) {
  'use strict';

  var MAX_PER_VISIT = 6;

  /** The ids that need a still, in the list's own order (newest first - the
   *  ones likeliest to be shared next), minus anything already tried this
   *  session, capped. */
  function pick(projects, tried, cap) {
    var max = cap == null ? MAX_PER_VISIT : cap;
    var has = Object.prototype.hasOwnProperty;
    var seen = Object.create(null);
    var out = [];
    (projects || []).forEach(function (p) {
      if (out.length >= max || !p || typeof p.id !== 'string' || !p.id) return;
      // Own properties only: an id that happens to be "constructor" must not
      // read as already tried off Object.prototype.
      if (p.hasStill === true || seen[p.id] || (tried && has.call(tried, p.id))) return;
      seen[p.id] = true;
      out.push(p.id);
    });
    return out;
  }

  /** Whether this visit may spend anything on it at all. */
  function allowed(env) {
    if (!env) return false;
    if (env.hidden) return false;
    if (env.saveData) return false;
    if (env.reducedData) return false;
    if (env.framed || env.tour) return false;
    return true;
  }

  /**
   * deps: {
   *   list():            Promise<projects[]>        (GET /api/projects)
   *   load(id):          Promise<project>           (GET /api/projects/:id)
   *   upload(project):   Promise<boolean>           (draw + PUT still)
   *   idle():            Promise<void>              (resolves when the page is idle)
   *   hidden():          boolean                    (is the tab in the background now)
   *   tried:             {id: true}                 (read and written: this session's attempts)
   *   cap:               number                     (optional, default MAX_PER_VISIT)
   * }
   * Resolves to {done, failed, stopped}. Never throws.
   */
  async function run(deps) {
    var result = { done: 0, failed: 0, stopped: false };
    try {
      await deps.idle();
      if (deps.hidden()) { result.stopped = true; return result; }
      var ids = pick(await deps.list(), deps.tried, deps.cap);
      for (var i = 0; i < ids.length; i++) {
        if (i > 0) await deps.idle();
        if (deps.hidden()) { result.stopped = true; break; }
        var id = ids[i];
        if (deps.tried) deps.tried[id] = true;
        var ok = false;
        try {
          var p = await deps.load(id);
          if (deps.hidden()) { result.stopped = true; break; }
          ok = p && p.viz ? await deps.upload(p) : false;
        } catch (e) { ok = false; }
        if (ok) result.done++; else result.failed++;
      }
    } catch (e) { /* a list that failed to load is nothing to fill */ }
    return result;
  }

  var api = { pick: pick, allowed: allowed, run: run, MAX_PER_VISIT: MAX_PER_VISIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StillBackfill = api;
})(typeof window !== 'undefined' ? window : this);
