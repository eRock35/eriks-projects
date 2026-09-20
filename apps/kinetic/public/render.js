/* Kinetic renderer: four animations on one canvas, no dependencies.
 *
 * Everything draws into a single 2D context at device pixel ratio. The
 * animations share one clock so playback, scrubbing and speed work the same
 * way for all of them, and each type only has to answer "what does this look
 * like at time t".
 *
 * Motion rules kept throughout, because they are what separates something
 * that feels alive from something that merely moves:
 *   - ease everything; linear motion reads as mechanical
 *   - interpolate POSITION as well as size, so bars slide past each other
 *     instead of teleporting when the ranking changes
 *   - never animate away from zero on a value that was simply missing
 *   - respect prefers-reduced-motion by jumping to the final state
 */
(function (global) {
  'use strict';

  var PALETTE = [
    '#5B8DEF', '#FF6B6B', '#3DD68C', '#FFB84D', '#B57BFF',
    '#3ED0E0', '#FF8FB1', '#9BD65B', '#F97C5A', '#7C9CFF',
    '#E86AC9', '#4FC3A1', '#FFD166', '#8AA0FF'
  ];

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  /* A NaN or out-of-range index silently becomes undefined in JS, and the
   * renderer then throws mid-frame and the animation freezes with no clue
   * why. Every frame lookup goes through here. */
  function frameAt(list, i) {
    var n = list.length;
    if (!n) return null;
    var k = Math.round(Number(i));
    if (!isFinite(k)) k = 0;
    return list[clamp(k, 0, n - 1)];
  }

  function colorFor(name, index) {
    if (typeof index === 'number') return PALETTE[index % PALETTE.length];
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function fmt(value, format) {
    var n = Number(value) || 0;
    var abs = Math.abs(n);
    var compact = function (x) {
      if (abs >= 1e12) return (x / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
      if (abs >= 1e9) return (x / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
      if (abs >= 1e6) return (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (abs >= 1e4) return Math.round(x / 1e3) + 'k';
      return Math.round(x).toLocaleString();
    };
    if (format === 'currency') return '$' + compact(n);
    if (format === 'percent') return (Math.round(n * 10) / 10) + '%';
    if (format === 'compact') return compact(n);
    if (abs >= 1e4) return compact(n);
    return (Math.round(n * 100) / 100).toLocaleString();
  }

  function truncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    return s + '…';
  }

  /* ---------- the player ---------- */

  function Player(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.viz = null;
    this.t = 0;              // 0..1 through the whole animation
    this.playing = false;
    this.speed = 1;
    this.loop = true;
    this.duration = 6000;
    this._raf = null;
    this._last = 0;
    this.reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._resize = this.resize.bind(this);
    global.addEventListener('resize', this._resize);
  }

  Player.prototype.load = function (viz) {
    this.viz = viz;
    this.t = 0;
    if (viz && viz.type === 'race') this.duration = Math.max(4000, Math.min(20000, viz.frames.length * 900));
    else if (viz && viz.type === 'line') this.duration = 4500;
    else if (viz && viz.type === 'flow') this.duration = 9000;
    else this.duration = 2600;
    this.resize();
    if (this.reduced) { this.t = 1; this.draw(); }
    else this.play();
  };

  Player.prototype.resize = function () {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.draw();
  };

  Player.prototype.play = function () {
    if (this.playing || !this.viz) return;
    if (this.t >= 1) this.t = 0;
    this.playing = true;
    this._last = global.performance.now();
    var self = this;
    var step = function (now) {
      if (!self.playing) return;
      var dt = now - self._last;
      self._last = now;
      var step2 = (dt / self.duration) * self.speed;
      // One bad frame time must not poison the clock for the rest of the run.
      self.t = isFinite(step2) ? self.t + step2 : self.t;
      if (!isFinite(self.t)) self.t = 0;
      if (self.t >= 1) {
        self.t = 1;
        self.draw();
        if (self.loop) { self.t = 0; }
        else { self.playing = false; self._emit(); return; }
      }
      self.draw();
      self._emit();
      self._raf = global.requestAnimationFrame(step);
    };
    this._raf = global.requestAnimationFrame(step);
    this._emit();
  };

  Player.prototype.pause = function () {
    this.playing = false;
    if (this._raf) global.cancelAnimationFrame(this._raf);
    this._emit();
  };

  Player.prototype.toggle = function () { this.playing ? this.pause() : this.play(); };

  Player.prototype.seek = function (t) {
    var n = Number(t);
    this.t = clamp(isFinite(n) ? n : 0, 0, 1);
    this.draw();
    this._emit();
  };

  Player.prototype.destroy = function () {
    this.pause();
    global.removeEventListener('resize', this._resize);
  };

  Player.prototype._emit = function () {
    if (this.opts.onTick) this.opts.onTick(this.t, this.playing, this.caption());
  };

  Player.prototype.caption = function () {
    var v = this.viz;
    if (!v) return '';
    if (v.type === 'race' && v.frames && v.frames.length) {
      var f = frameAt(v.frames, this.t * (v.frames.length - 1));
      return f ? f.label : '';
    }
    if (v.type === 'line' && v.x && v.x.length) {
      var xi = clamp(Math.round(this.t * (v.x.length - 1)) || 0, 0, v.x.length - 1);
      return String(v.x[xi]);
    }
    return '';
  };

  Player.prototype.draw = function () {
    var ctx = this.ctx, v = this.viz;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!v) return;
    var bg = this.opts.background || '#0B0D12';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);
    // One clamp for all four, so no renderer can be handed a time it cannot
    // draw. Canvas throws on a non-finite coordinate, which freezes the frame
    // and leaves nothing on screen to explain it.
    var t = isFinite(this.t) ? clamp(this.t, 0, 1) : 0;
    if (v.type === 'race') drawRace(ctx, v, t, this.w, this.h);
    else if (v.type === 'line') drawLine(ctx, v, t, this.w, this.h);
    else if (v.type === 'flow') drawFlow(ctx, v, t, this.w, this.h);
    else drawBars(ctx, v, t, this.w, this.h);
  };

  /* ---------- race: bars that overtake ---------- */

  function drawRace(ctx, v, t, W, H) {
    var frames = v.frames || [];
    if (!frames.length) return;
    var safeT = isFinite(t) ? clamp(t, 0, 1) : 0;
    var pos = safeT * (frames.length - 1);
    var i = clamp(Math.floor(isFinite(pos) ? pos : 0), 0, Math.max(0, frames.length - 2));
    var localRaw = clamp(pos - i, 0, 1);
    var local = easeInOutCubic(localRaw);
    var a = frameAt(frames, i), b = frameAt(frames, i + 1);
    if (!a || !b) return;
    a = { values: a.values || [] };
    b = { values: b.values || [] };

    var byName = {};
    a.values.forEach(function (d) { byName[d.name] = { from: d.value, to: d.value }; });
    b.values.forEach(function (d) {
      if (!byName[d.name]) byName[d.name] = { from: 0, to: d.value };
      else byName[d.name].to = d.value;
    });

    var rows = Object.keys(byName).map(function (name) {
      var d = byName[name];
      return { name: name, value: lerp(d.from, d.to, local) };
    });

    // Interpolate RANK as well as value, so a bar that overtakes another
    // slides past it instead of jumping a row.
    var rankA = {}, rankB = {};
    a.values.slice().sort(function (x, y) { return y.value - x.value; }).forEach(function (d, k) { rankA[d.name] = k; });
    b.values.slice().sort(function (x, y) { return y.value - x.value; }).forEach(function (d, k) { rankB[d.name] = k; });
    rows.forEach(function (r) {
      var ra = rankA[r.name] === undefined ? rows.length : rankA[r.name];
      var rb = rankB[r.name] === undefined ? rows.length : rankB[r.name];
      r.slot = lerp(ra, rb, local);
    });
    rows.sort(function (x, y) { return x.slot - y.slot; });

    // Interpolating rank linearly means two bars trading places pass through
    // the SAME slot, and at the moment of the overtake - the one thing the
    // viewer is watching for - they draw on top of each other with their
    // labels overlapping. Push any pair that gets too close apart
    // symmetrically, so they slide past with a visible sliver between them
    // and still finish in the swapped order.
    var MIN_GAP = 0.84;
    for (var pass = 0; pass < 3; pass++) {
      for (var q = 1; q < rows.length; q++) {
        var gap = rows[q].slot - rows[q - 1].slot;
        if (gap < MIN_GAP) {
          var push = (MIN_GAP - gap) / 2;
          rows[q - 1].slot -= push;
          rows[q].slot += push;
        }
      }
      if (rows.length) {
        // Keep the whole group inside the stage after the pushing.
        var lift = Math.min(0, rows[0].slot);
        if (lift < 0) rows.forEach(function (rr) { rr.slot -= lift; });
      }
    }

    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    var padT = Math.max(18, H * 0.06), padB = Math.max(36, H * 0.13);
    var n = rows.length;
    var avail = H - padT - padB;
    // Without a ceiling, two tracks each get half the stage and end up at
    // opposite ends with a void between them.
    var lane = Math.min(avail / Math.max(n, 1), 62);
    var top = padT + Math.max(0, (avail - lane * n) / 2);
    var barH = Math.min(lane * 0.72, 46);
    var labelW = Math.min(Math.max(W * 0.28, 78), 190);
    var valueW = 74;
    var trackW = Math.max(30, W - labelW - valueW - 26);

    ctx.textBaseline = 'middle';
    rows.forEach(function (r, k) {
      var y = top + r.slot * lane + lane / 2;
      var w = Math.max(2, (r.value / max) * trackW);
      var x = labelW + 10;
      var col = colorFor(r.name);

      ctx.font = '600 ' + Math.min(15, Math.max(11, barH * 0.42)) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.textAlign = 'right';
      ctx.fillText(truncate(ctx, r.name, labelW - 4), labelW, y);

      var grad = ctx.createLinearGradient(x, 0, x + w, 0);
      grad.addColorStop(0, col);
      grad.addColorStop(1, col + 'BB');
      ctx.fillStyle = grad;
      roundRect(ctx, x, y - barH / 2, w, barH, Math.min(6, barH / 2));
      ctx.fill();

      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '700 ' + Math.min(14, Math.max(11, barH * 0.4)) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(fmt(Math.round(r.value), v.meta.valueFormat), x + w + 8, y);
    });

    // The period, set big and low-contrast behind the bars.
    var labelFrame = frameAt(frames, pos);
    var label = labelFrame ? labelFrame.label : '';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '800 ' + Math.min(64, Math.max(28, W * 0.09)) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.fillText(label, W - 14, H - 16);

    ctx.textAlign = 'left';
    ctx.font = '500 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(v.meta.valueLabel || '', 14, H - 18);
  }

  /* ---------- line: draws itself in ---------- */

  function drawLine(ctx, v, t, W, H) {
    var padL = 44, padR = 16, padT = 20, padB = 34;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var all = [];
    v.series.forEach(function (s) { s.values.forEach(function (n) { if (n !== null) all.push(n); }); });
    if (!all.length) return;
    var max = Math.max.apply(null, all), min = Math.min.apply(null, all);
    if (max === min) { max = max + 1; min = min - 1; }
    var yFor = function (val) { return padT + plotH - ((val - min) / (max - min)) * plotH; };
    var xFor = function (i) { return padL + (v.x.length === 1 ? plotW / 2 : (i / (v.x.length - 1)) * plotW); };

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (plotH / 4) * g;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '500 10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmt(max - ((max - min) / 4) * g, v.meta.valueFormat), padL - 6, gy);
    }

    var progress = easeOutCubic(t) * (v.x.length - 1);
    v.series.forEach(function (s, si) {
      var col = colorFor(s.name, si);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      var started = false, lastX = 0, lastY = 0;
      for (var i = 0; i < v.x.length; i++) {
        if (i > progress) break;
        var val = s.values[i];
        if (val === null) continue;
        var px = xFor(i), py = yFor(val);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        lastX = px; lastY = py;
      }
      // Partial segment to the sub-step position, so the tip moves smoothly.
      var fi = Math.floor(progress);
      if (started && fi + 1 < v.x.length && s.values[fi] !== null && s.values[fi + 1] !== null) {
        var frac = progress - fi;
        var px2 = lerp(xFor(fi), xFor(fi + 1), frac);
        var py2 = lerp(yFor(s.values[fi]), yFor(s.values[fi + 1]), frac);
        ctx.lineTo(px2, py2); lastX = px2; lastY = py2;
      }
      ctx.stroke();
      if (started) {
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(lastX, lastY, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(lastX, lastY, 10, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        if (v.series.length > 1) {
          ctx.font = '600 11px -apple-system, sans-serif';
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(truncate(ctx, s.name, 90), lastX + 9, lastY);
        }
      }
    });

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '500 11px -apple-system, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(v.x[0]), padL, H - 12);
    ctx.textAlign = 'right';
    ctx.fillText(String(v.x[v.x.length - 1]), W - padR, H - 12);
  }

  /* ---------- bars: grow in, staggered ---------- */

  function drawBars(ctx, v, t, W, H) {
    var items = v.items || [];
    if (!items.length) return;
    var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));
    var padT = Math.max(16, H * 0.06), padB = Math.max(28, H * 0.1);
    var availB = H - padT - padB;
    var lane = Math.min(availB / items.length, 62);
    var topB = padT + Math.max(0, (availB - lane * items.length) / 2);
    var barH = Math.min(lane * 0.7, 44);
    var labelW = Math.min(Math.max(W * 0.3, 80), 200);
    var trackW = Math.max(30, W - labelW - 84);

    ctx.textBaseline = 'middle';
    items.forEach(function (d, k) {
      var stagger = clamp((t - (k / items.length) * 0.45) / 0.55, 0, 1);
      var grow = easeOutCubic(stagger);
      var y = topB + k * lane + lane / 2;
      var w = Math.max(1, (d.value / max) * trackW * grow);
      var x = labelW + 10;
      var col = colorFor(d.name, k);

      ctx.globalAlpha = clamp(stagger * 2, 0, 1);
      ctx.font = '600 ' + Math.min(15, Math.max(11, barH * 0.42)) + 'px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.textAlign = 'right';
      ctx.fillText(truncate(ctx, d.name, labelW - 4), labelW, y);

      var grad = ctx.createLinearGradient(x, 0, x + Math.max(w, 1), 0);
      grad.addColorStop(0, col);
      grad.addColorStop(1, col + 'AA');
      ctx.fillStyle = grad;
      roundRect(ctx, x, y - barH / 2, w, barH, Math.min(6, barH / 2));
      ctx.fill();

      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '700 ' + Math.min(14, Math.max(11, barH * 0.4)) + 'px ui-monospace, Menlo, monospace';
      ctx.fillText(fmt(Math.round(d.value * grow), v.meta.valueFormat), x + w + 8, y);
      ctx.globalAlpha = 1;
    });
  }

  /* ---------- flow: particles along links ---------- */

  function drawFlow(ctx, v, t, W, H) {
    var nodes = v.nodes || [], links = v.links || [];
    if (!nodes.length || !links.length) return;

    var cx = W / 2, cy = H / 2;
    // Leave room for the labels that sit outside the ring. At 0.36 the nodes
    // at three and nine o'clock pushed their text off the canvas.
    var r = Math.min(W * 0.34, H * 0.36) * 0.82;
    var byId = {};
    nodes.forEach(function (n, i) {
      var ang = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
      byId[n.id] = { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r, label: n.label, i: i, ang: ang };
    });

    var maxV = Math.max.apply(null, links.map(function (l) { return l.value; }).concat([1]));

    links.forEach(function (l) {
      var A = byId[l.from], B = byId[l.to];
      if (!A || !B) return;
      var weight = l.value / maxV;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.05 + weight * 0.1).toFixed(3) + ')';
      ctx.lineWidth = 0.6 + weight * 3.4;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.quadraticCurveTo(cx, cy, B.x, B.y);
      ctx.stroke();
    });

    // Particles. Count scales with the link's share of total volume, so the
    // busy routes visibly carry more traffic rather than just being thicker.
    links.forEach(function (l, li) {
      var A = byId[l.from], B = byId[l.to];
      if (!A || !B) return;
      var weight = l.value / maxV;
      var count = Math.max(1, Math.round(weight * 9));
      var col = colorFor(l.from, A.i);
      for (var p = 0; p < count; p++) {
        var phase = (t * 1.6 + p / count + li * 0.13) % 1;
        var e = phase;
        var mt = 1 - e;
        var px = mt * mt * A.x + 2 * mt * e * cx + e * e * B.x;
        var py = mt * mt * A.y + 2 * mt * e * cy + e * e * B.y;
        var fade = Math.sin(Math.PI * e);
        ctx.globalAlpha = 0.25 + fade * 0.7;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(px, py, 1.4 + weight * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });

    nodes.forEach(function (n, i) {
      var P = byId[n.id];
      var out = links.filter(function (l) { return l.from === n.id || l.to === n.id; })
        .reduce(function (s, l) { return s + l.value; }, 0);
      var size = 4 + (out / maxV) * 6;
      var col = colorFor(n.id, i);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(P.x, P.y, size, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.18;
      ctx.beginPath(); ctx.arc(P.x, P.y, size + 7 + Math.sin(t * Math.PI * 4 + i) * 2, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      var outward = Math.cos(P.ang) >= 0;
      var lx = P.x + (outward ? size + 6 : -(size + 6));
      // However far the label sits from its node, it has to end on the canvas.
      var room = Math.max(24, outward ? (W - 6) - lx : lx - 6);
      ctx.textAlign = outward ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(ctx, P.label, Math.min(room, 110)), lx, P.y);
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, Math.abs(w) / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  global.Kinetic = { Player: Player, fmt: fmt, PALETTE: PALETTE, colorFor: colorFor };
})(window);
