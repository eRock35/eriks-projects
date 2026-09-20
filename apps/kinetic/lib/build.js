// Turning a table plus a mapping into frames the renderer can play.
//
// Entirely deterministic and entirely server-side. Every number here comes
// from the table the person supplied; nothing is generated, rounded away or
// guessed. If the mapping does not fit, this falls back rather than inventing
// a shape that happens to render.

const MAX_TRACKS = 14;   // more bars than this on a phone is a smear
const MAX_FRAMES = 200;

/** "$1,234.5M", "12%", "(400)" -> a number. Returns null when there isn't one. */
function toNumber(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/^\((.*)\)$/, '$1');
  let scale = 1;
  const suffix = s.match(/([kmbt])\s*$/i);
  if (suffix) {
    scale = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[suffix[1].toLowerCase()];
    s = s.slice(0, suffix.index);
  }
  s = s.replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s) * scale;
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Sortable key for a time label, so "2020" and "Q3 2021" both order right. */
function timeKey(label) {
  const s = String(label).trim();
  const iso = Date.parse(s);
  if (!Number.isNaN(iso) && /\d{4}/.test(s)) return iso;
  const n = toNumber(s);
  if (n !== null) return n;
  return s.toLowerCase();
}

function sortTimes(values) {
  return values.slice().sort((a, b) => {
    const ka = timeKey(a), kb = timeKey(b);
    if (typeof ka === 'number' && typeof kb === 'number') return ka - kb;
    return String(ka).localeCompare(String(kb), undefined, { numeric: true });
  });
}

function colIndex(header, name) {
  const i = header.indexOf(name);
  return i >= 0 ? i : -1;
}

/** A column of 4-digit integers in a plausible calendar range is a year, and
 *  summing years produces a chart that is arithmetically valid and completely
 *  meaningless. */
function looksLikeYears(rows, c) {
  let years = 0, numbers = 0;
  for (const r of rows.slice(0, 200)) {
    const n = toNumber(r[c]);
    if (n === null) continue;
    numbers++;
    if (Number.isInteger(n) && n >= 1900 && n <= 2100 && String(r[c]).trim().length === 4) years++;
  }
  return numbers > 0 && years / numbers > 0.7;
}

/** Pick a value column when the model did not name a usable one. The column
 *  with the most parseable numbers wins, years are excluded, and later
 *  columns beat earlier ones on a tie because tables put measures last. */
function guessValueCol(header, rows) {
  let best = -1, bestScore = 0;
  for (let c = 0; c < header.length; c++) {
    if (looksLikeYears(rows, c)) continue;
    let n = 0;
    for (const r of rows.slice(0, 200)) if (toNumber(r[c]) !== null) n++;
    if (n >= bestScore) { bestScore = n; best = c; }
  }
  return bestScore >= Math.min(3, rows.length) ? best : -1;
}

/** The thing being measured is almost always the text column. Preferring a
 *  numeric one produced "2022" as a bar label with the years summed behind
 *  it, which renders perfectly and means nothing. */
function guessNameCol(header, rows, exclude) {
  const sample = rows.slice(0, 200);
  let fallback = -1;
  for (let c = 0; c < header.length; c++) {
    if (c === exclude) continue;
    const distinct = new Set(sample.map((r) => r[c])).size;
    if (distinct <= 1) continue;
    if (fallback < 0) fallback = c;
    const numeric = sample.filter((r) => toNumber(r[c]) !== null).length;
    if (numeric / Math.max(sample.length, 1) < 0.5) return c; // mostly text: a name
  }
  if (fallback >= 0) return fallback;
  return exclude === 0 ? 1 : 0;
}

function build(table, spec) {
  const header = table[0].map(String);
  const rows = table.slice(1);

  let vi = colIndex(header, spec.valueCol);
  if (vi < 0) vi = guessValueCol(header, rows);
  let ni = colIndex(header, spec.nameCol);
  if (ni < 0) ni = guessNameCol(header, rows, vi);
  const ti = colIndex(header, spec.timeCol);
  const si = colIndex(header, spec.seriesCol);
  const fi = colIndex(header, spec.fromCol);
  const toi = colIndex(header, spec.toCol);

  const meta = {
    valueFormat: spec.valueFormat || 'number',
    valueLabel: spec.valueLabel || header[vi] || 'value',
    timeLabel: ti >= 0 ? header[ti] : '',
  };

  if (spec.vizType === 'flow' && fi >= 0 && toi >= 0 && vi >= 0) {
    const links = new Map();
    const nodes = new Set();
    for (const r of rows) {
      const from = String(r[fi] || '').trim();
      const to = String(r[toi] || '').trim();
      const v = toNumber(r[vi]);
      if (!from || !to || v === null || v <= 0) continue;
      nodes.add(from); nodes.add(to);
      const key = `${from}\u0000${to}`;
      links.set(key, (links.get(key) || 0) + v);
    }
    if (links.size) {
      return {
        type: 'flow', meta,
        nodes: [...nodes].slice(0, 40).map((n) => ({ id: n, label: n })),
        links: [...links.entries()].map(([k, v]) => {
          const [from, to] = k.split('\u0000');
          return { from, to, value: v };
        }).filter((l) => l.value > 0).sort((a, b) => b.value - a.value).slice(0, 120),
      };
    }
  }

  if (spec.vizType === 'race' && ti >= 0 && ni >= 0 && vi >= 0) {
    const times = sortTimes([...new Set(rows.map((r) => String(r[ti]).trim()).filter(Boolean))]);
    if (times.length >= 3) {
      const byName = new Map();
      for (const r of rows) {
        const name = String(r[ni] || '').trim();
        const t = String(r[ti] || '').trim();
        const v = toNumber(r[vi]);
        if (!name || !t || v === null) continue;
        if (!byName.has(name)) byName.set(name, new Map());
        byName.get(name).set(t, v);
      }
      // Rank by the largest value each name ever reaches, so the tracks that
      // matter survive the cut rather than whoever happens to lead at the end.
      const peak = [...byName.entries()]
        .map(([name, m]) => ({ name, peak: Math.max(...m.values()) }))
        .sort((a, b) => b.peak - a.peak)
        .slice(0, MAX_TRACKS)
        .map((x) => x.name);
      const use = times.slice(0, MAX_FRAMES);
      const frames = use.map((t) => ({
        label: t,
        values: peak.map((name) => {
          const m = byName.get(name);
          let v = m.get(t);
          if (v === undefined) {
            // Carry the last known value forward rather than dropping to zero,
            // which would make a missing row look like a collapse.
            for (const past of use.slice(0, use.indexOf(t)).reverse()) {
              if (m.get(past) !== undefined) { v = m.get(past); break; }
            }
          }
          return { name, value: v === undefined ? 0 : v };
        }),
      }));
      if (frames.length >= 3) return { type: 'race', meta, frames };
    }
  }

  if (spec.vizType === 'line' && ti >= 0 && vi >= 0) {
    const xs = sortTimes([...new Set(rows.map((r) => String(r[ti]).trim()).filter(Boolean))]).slice(0, MAX_FRAMES);
    const groups = new Map();
    for (const r of rows) {
      const key = si >= 0 ? String(r[si] || '').trim() : (meta.valueLabel || 'series');
      const t = String(r[ti] || '').trim();
      const v = toNumber(r[vi]);
      if (!t || v === null) continue;
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(t, v);
    }
    const series = [...groups.entries()].slice(0, MAX_TRACKS).map(([name, m]) => ({
      name,
      values: xs.map((t) => (m.has(t) ? m.get(t) : null)),
    })).filter((s) => s.values.some((v) => v !== null));
    if (xs.length >= 2 && series.length) return { type: 'line', meta, x: xs, series };
  }

  // bars, and the honest fallback for everything that did not fit above
  const totals = new Map();
  for (const r of rows) {
    const name = String(r[ni] || '').trim();
    const v = toNumber(r[vi]);
    if (!name || v === null) continue;
    totals.set(name, (totals.get(name) || 0) + v);
  }
  const items = [...totals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_TRACKS);
  if (!items.length) throw Object.assign(new Error('No numbers could be read from that table.'), { status: 422 });
  return { type: 'bars', meta, items };
}

module.exports = { build, toNumber, sortTimes, MAX_TRACKS };
