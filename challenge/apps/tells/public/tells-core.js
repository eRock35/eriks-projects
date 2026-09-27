/* Tells - the quick scan, and everything the page, the server, the Chrome
 * extension and the tests must agree on.
 *
 * UMD: the page loads it as window.TellsCore, the server and tests require()
 * it, and the extension carries a byte-identical copy (test/run.js checks).
 * No model call, no network, no storage. Pure functions over strings.
 *
 * THE HONESTY SPINE. Nothing here says a text "is AI". It finds tells: exact
 * spans that templated or model-written prose over-uses, each with a reason,
 * and turns them into a LOW-confidence likelihood. Formal human writing -
 * and non-native English, and anyone who was taught to write "clearly" - hits
 * some of these rules too, and light editing removes most of them. So every
 * result carries LIMITS_LINE, and a score is never drawn without its reasons.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TellsCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var LIMITS = { text: 20000, url: 2048, minWords: 40 };
  var LIMITS_LINE = 'A signal, not proof. Formal human writing can score high; edited AI text can score low.';
  var METADATA_NOTE = 'Most platforms strip metadata on upload, so finding none means nothing either way.';
  var VISUAL_NOTE = 'A visual read is a weak signal: good AI images pass it, and real photos can look odd.';
  var ORIGINAL_NONE = 'No close earlier match found in a web search.';

  var CATEGORIES = {
    stock: 'Stock phrase',
    hype: 'Set-up line',
    construction: '“Not X, but Y”',
    vocabulary: 'AI-favoured word',
    hedge: 'Filler hedge',
    punctuation: 'Em dash',
    format: 'Formatting',
    rhythm: 'Even rhythm',
    list: 'Rule of three',
  };

  /* ---------------- helpers ---------------- */

  function clean(s, max) {
    s = String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '');
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function words(text) { return String(text).match(/[A-Za-zÀ-ɏ0-9][A-Za-zÀ-ɏ0-9'’-]*/g) || []; }
  function sentencesOf(text) {
    var out = [];
    var re = /[^.!?\n]+[.!?]*/g, m;
    while ((m = re.exec(text))) {
      var w = words(m[0]).length;
      if (w >= 3) out.push(w);
    }
    return out;
  }
  function round(n, d) { var p = Math.pow(10, d || 0); return Math.round(n * p) / p; }

  /* ---------------- the rules ---------------- */

  // Each rule: id, category, label, reason (one plain line), weight (points
  // per hit), cap (hits that count), and either a regex whose matches are the
  // spans or a function that returns spans. A rule's points are
  // weight x min(hits, cap). `min` is how many hits it takes before any count
  // (the rule of three is ordinary once; it is a tic five times).
  function phrases(list) {
    return new RegExp('(?:^|[^A-Za-z])(' + list.join('|') + ')(?![A-Za-z])', 'gi');
  }
  var RULES = [
    {
      id: 'opener', category: 'stock', weight: 3, cap: 3,
      reason: 'A stock opener that model-written and templated posts lean on.',
      re: phrases([
        "in today['’]?s (?:fast[- ]paced|ever[- ](?:evolving|changing)|rapidly (?:changing|evolving)|digital|modern|competitive) (?:world|landscape|age|era|market|environment)",
        "in the (?:ever[- ](?:evolving|changing)|fast[- ]paced|dynamic) (?:world|landscape|realm) of",
        "let['’]?s dive (?:in|into|deeper)", "let['’]?s break (?:it|this) down", "buckle up",
        "here['’]?s the thing", "picture this", "imagine a world", "ever wondered",
        "i['’]?m (?:so |truly |incredibly )?(?:thrilled|excited|delighted|humbled|honou?red|proud) to (?:announce|share)",
        "in the realm of", "when it comes to", "at the end of the day",
        "in an era (?:of|where|when)", "as we navigate", "the world of [a-z]+ is changing",
      ]),
    },
    {
      id: 'closer', category: 'stock', weight: 3, cap: 3,
      reason: 'A stock closer or engagement bait at the end of a post.',
      re: phrases([
        'agree\\?', 'thoughts\\?', 'what do you think\\?', "what['’]?s your take\\?", 'let me know in the comments',
        'drop (?:a|your) (?:comment|thoughts)', 'repost (?:if|to)', '♻️', 'follow (?:me )?for more',
        'in conclusion', 'in summary', 'to sum up', 'the bottom line', 'the future (?:is|belongs to) ',
        'the choice is yours', 'stay curious',
      ]),
    },
    {
      id: 'setup', category: 'hype', weight: 3, cap: 3,
      reason: 'A set-up line that teases the next line instead of saying it.',
      re: phrases([
        "here['’]?s (?:why|how|what (?:i learned|happened|nobody tells you))", 'the result\\?', 'the best part\\?',
        'the kicker\\?', 'the secret\\?', 'spoiler:', 'plot twist:', 'hot take:', 'unpopular opinion:',
        'let that sink in', 'read that again', "and that['’]?s okay", 'this changes everything',
        "(?:but )?here['’]?s the (?:kicker|catch|truth)",
      ]),
    },
    {
      id: 'notxbuty', category: 'construction', weight: 4, cap: 3,
      reason: 'The “it’s not X, it’s Y” turn, a favourite of model-written prose.',
      re: /(?:\b(?:it|this|that)(?:['’]s| is| was) not (?:just |only |merely |about )?[^.!?\n]{1,60}?[.,;:—–-]+\s*(?:it|this|that)(?:['’]s| is| was)\b|\bnot (?:just|only|merely) [^.!?\n]{1,60}?,? but (?:also )?\b|\b(?:isn['’]t|wasn['’]t) (?:just |only |about )?[^.!?\n]{1,50}?[.;—–-]+\s*(?:it|this|that)(?:['’]s| is| was)\b)/gi,
    },
    {
      id: 'vocab', category: 'vocabulary', weight: 1.5, cap: 8,
      reason: 'A word models reach for far more often than people do.',
      re: phrases([
        'delve[sd]?', 'delving', 'tapestry', 'testament to', 'navigat(?:e|ing) the (?:complex |ever[- ]changing |evolving )?(?:landscape|complexities|world)',
        'landscape', 'game[- ]changer', 'game[- ]changing', 'unlock(?:s|ing|ed)?', 'elevat(?:e|es|ing)', 'leverag(?:e|es|ing)',
        'seamless(?:ly)?', 'robust', 'realm', 'pivotal', 'foster(?:s|ing)?', 'empower(?:s|ing)?', 'synerg(?:y|ies)',
        'holistic', 'cutting[- ]edge', 'transformative', 'paradigm', 'embark(?:s|ing)?', 'multifaceted', 'intricate',
        'underscore[sd]?', 'showcas(?:e|es|ing)', 'streamlin(?:e|es|ing)', 'harness(?:es|ing)?', 'resonate[sd]?',
        'vibrant', 'bustling', 'meticulous(?:ly)?', 'in essence', 'moreover', 'furthermore', 'ever[- ]evolving',
        'thought leadership', 'actionable insights?', 'deep dive', 'unparalleled', 'invaluable',
      ]),
    },
    {
      id: 'hedge', category: 'hedge', weight: 2, cap: 3,
      reason: 'Filler that announces a point instead of making it.',
      re: phrases([
        "it['’]?s (?:important|worth|crucial|essential|vital) to (?:note|remember|mention|recognize|recognise|understand)",
        "it['’]?s worth noting", 'it is worth (?:noting|mentioning)', 'it is important to (?:note|remember)',
        'keep in mind that', 'needless to say', 'it goes without saying', 'as an ai',
      ]),
    },
    {
      id: 'emdash', category: 'punctuation', weight: 1, cap: 5,
      reason: 'Em dashes, used this densely, are a common tell of model-written text.',
      fn: function (text, ctx) {
        var out = [], re = /—|\s–\s|\s--\s/g, m;
        while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length });
        // Density, not presence: plenty of people use the odd dash.
        if (out.length < 2 || out.length / Math.max(ctx.words, 1) * 100 < 1) return [];
        return out;
      },
    },
    {
      id: 'emoji-bullets', category: 'format', weight: 1.5, cap: 4,
      reason: 'Lines that start with ✅ 🚀 👉 💡-style emoji bullets, the template of a certain kind of post.',
      fn: function (text) {
        var out = [], re = /(^|\n)[ \t]*((?:\p{Extended_Pictographic}|[✔☑➡→►▶])️?)/gu, m;
        while ((m = re.exec(text))) {
          var s = m.index + m[1].length + (m[0].length - m[1].length - m[2].length);
          out.push({ start: s, end: s + m[2].length });
        }
        return out.length >= 2 ? out : [];
      },
    },
    {
      id: 'hashtags', category: 'format', weight: 1, cap: 4,
      reason: 'A stack of hashtags at the end of a post.',
      fn: function (text) {
        var out = [], re = /(^|\s)(#[A-Za-z][\w]{1,40})/g, m;
        while ((m = re.exec(text))) out.push({ start: m.index + m[1].length, end: m.index + m[0].length });
        return out.length >= 3 ? out : [];
      },
    },
    {
      id: 'headers', category: 'format', weight: 1.5, cap: 3,
      reason: 'Symmetric bold or “Title: subtitle” headers, like a generated outline.',
      fn: function (text) {
        var out = [], re = /(^|\n)[ \t]*((?:#{1,4} [^\n]{2,60})|(?:\*\*[^*\n]{2,60}\*\*:?)|(?:[A-Z][A-Za-z'’ ]{2,40}: [A-Z][^\n]{0,60}))(?=\n|$)/g, m;
        while ((m = re.exec(text))) {
          var s = m.index + m[1].length + (m[0].length - m[1].length - m[2].length);
          out.push({ start: s, end: s + m[2].length });
        }
        return out.length >= 3 ? out : [];
      },
    },
    {
      id: 'three', category: 'list', weight: 1, cap: 3, min: 2,
      reason: 'A list of exactly three (“fast, simple, and powerful”), again and again.',
      re: /\b[A-Za-z'’-]+(?: [A-Za-z'’-]+)?, [A-Za-z'’-]+(?: [A-Za-z'’-]+)?,? and [A-Za-z'’-]+(?: [A-Za-z'’-]+)?\b/g,
    },
  ];

  // Whole-text signals: measured, not spans.
  function rhythm(text) {
    var s = sentencesOf(text);
    if (s.length < 8) return null;
    var mean = s.reduce(function (a, b) { return a + b; }, 0) / s.length;
    var sd = Math.sqrt(s.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / s.length);
    var cv = sd / mean;
    // Measured, and weak: plenty of careful writers are even. Only a very
    // flat rhythm over eight or more sentences counts.
    if (cv >= 0.22) return null;
    return {
      rule: 'rhythm', category: 'rhythm', weight: cv < 0.15 ? 3 : 2, value: round(cv, 2),
      label: CATEGORIES.rhythm,
      reason: 'Sentences are unusually even in length (variation ' + round(cv, 2) + '; people usually vary more than 0.5).',
    };
  }
  function broetry(text) {
    // Many short paragraphs, a sentence or two each, blank lines between.
    var paras = text.split(/\n[ \t]*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    if (paras.length < 6) return null;
    var short = paras.filter(function (p) {
      return words(p).length <= 20 && (p.match(/[.!?:](\s|$)/g) || []).length <= 2;
    }).length;
    if (short / paras.length < 0.75) return null;
    return {
      rule: 'broetry', category: 'format', weight: 3, value: paras.length,
      label: 'One line per thought',
      reason: paras.length + ' short paragraphs of a line or two each: the “broetry” layout of templated posts.',
    };
  }

  /* ---------------- the quick scan ---------------- */

  function strengthOf(w) { return w >= 3 ? 'medium' : 'low'; }

  /**
   * The quick scan. Deterministic, instant, free.
   * @returns {score 0-97, confidence:'low', words, hits:[span], signals, points, tooShort, limits}
   */
  function scan(input) {
    var text = clean(input, LIMITS.text);
    var wc = words(text).length;
    var ctx = { words: wc };
    var hits = [];
    var points = 0;
    var byRule = {};
    RULES.forEach(function (r) {
      var found = [];
      if (r.re) {
        r.re.lastIndex = 0;
        var m, guard = 0;
        while ((m = r.re.exec(text)) && guard++ < 500) {
          var q = m[1] !== undefined && r.re.source.indexOf('(?:^|[^A-Za-z])(') === 0 ? m[1] : m[0];
          var start = m.index + m[0].indexOf(q);
          found.push({ start: start, end: start + q.length });
          if (m[0].length === 0) r.re.lastIndex++;
        }
      } else found = r.fn(text, ctx);
      if (!found.length || found.length < (r.min || 1)) return;
      byRule[r.id] = found.length;
      points += r.weight * Math.min(found.length, r.cap);
      found.forEach(function (f, i) {
        hits.push({
          id: r.id + '-' + i, rule: r.id, category: r.category, label: CATEGORIES[r.category],
          start: f.start, end: f.end, quote: text.slice(f.start, f.end),
          reason: r.reason, weight: r.weight, strength: strengthOf(r.weight), counted: i < r.cap,
        });
      });
    });
    var signals = [rhythm(text), broetry(text)].filter(Boolean);
    signals.forEach(function (s) { points += s.weight; });
    hits.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    // Longer texts collect more hits by chance; scale by the square root of
    // length past ~150 words so a long essay is not punished for being long.
    var p = points / Math.sqrt(Math.max(1, wc / 150));
    var score = Math.min(97, Math.round(100 * p / (p + 12)));
    return {
      version: VERSION, score: score, confidence: 'low', words: wc, points: round(points, 1),
      hits: hits, signals: signals, rules: byRule, tooShort: wc < LIMITS.minWords, limits: LIMITS_LINE,
      how: 'Each tell adds points (capped per rule); score = 100 × p ÷ (p + 12), where p is the points scaled down for texts over 150 words. Always low confidence.',
    };
  }

  /**
   * Cut the text into runs, each with the ids of the spans covering it, so a
   * page can draw overlapping highlights without nesting markup.
   * spans: [{id, start, end, ...}]
   */
  function segments(text, spans) {
    var cuts = [0, text.length];
    spans = (spans || []).filter(function (s) { return s && s.start >= 0 && s.end <= text.length && s.end > s.start; });
    spans.forEach(function (s) { cuts.push(s.start); cuts.push(s.end); });
    cuts = cuts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < cuts.length - 1; i++) {
      var a = cuts[i], b = cuts[i + 1];
      var ids = spans.filter(function (s) { return s.start <= a && s.end >= b; }).map(function (s) { return s.id; });
      out.push({ start: a, end: b, text: text.slice(a, b), ids: ids });
    }
    return out;
  }

  var RANK = { low: 1, medium: 2, high: 3 };
  function strongest(list) {
    var best = null;
    (list || []).forEach(function (s) { if (!best || (RANK[s] || 0) > (RANK[best] || 0)) best = s; });
    return best;
  }

  /**
   * One "Reads as AI" meter from whichever checks have come back, with the
   * band it deserves. Metadata naming an AI generator is the one strong
   * signal and dominates; otherwise the deep read beats the visual read beats
   * the quick scan. Never returns a verdict word, only a number, a range, a
   * confidence and what drove it.
   */
  var BAND = { low: 25, medium: 15, high: 7 };
  function combine(parts) {
    parts = parts || {};
    var basis = [];
    var pick = null;
    var metaAi = parts.meta && (parts.meta.findings || []).filter(function (f) { return f.strength === 'strong' && f.points === 'ai'; });
    if (parts.quick) basis.push({ source: 'quick', label: 'Quick scan', score: parts.quick.score, confidence: 'low' });
    if (parts.visual) basis.push({ source: 'visual', label: 'Visual read (weak)', score: parts.visual.likelihood, confidence: parts.visual.confidence });
    if (parts.deep) basis.push({ source: 'deep', label: 'Deep read', score: parts.deep.likelihood, confidence: parts.deep.confidence });
    if (metaAi && metaAi.length) {
      pick = { score: Math.max(95, parts.deep ? parts.deep.likelihood : 0), confidence: 'high', driver: 'meta' };
      basis.push({ source: 'meta', label: 'Metadata', score: pick.score, confidence: 'high' });
    } else if (parts.deep) pick = { score: parts.deep.likelihood, confidence: parts.deep.confidence, driver: 'deep' };
    else if (parts.visual) pick = { score: parts.visual.likelihood, confidence: parts.visual.confidence === 'high' ? 'medium' : parts.visual.confidence, driver: 'visual' };
    else if (parts.quick) pick = { score: parts.quick.score, confidence: 'low', driver: 'quick' };
    if (!pick) return null;
    var score = Math.max(0, Math.min(100, Math.round(pick.score)));
    var band = BAND[pick.confidence] || BAND.low;
    return {
      score: score, lo: Math.max(0, score - band), hi: Math.min(100, score + band),
      confidence: pick.confidence, driver: pick.driver, basis: basis, limits: LIMITS_LINE,
      camera: Boolean(parts.meta && (parts.meta.findings || []).some(function (f) { return f.points === 'camera'; })),
    };
  }

  function levelWord(score) {
    if (score >= 70) return 'Many tells';
    if (score >= 40) return 'Some tells';
    if (score >= 15) return 'Few tells';
    return 'Almost no tells';
  }

  /* ---------------- ?q= ---------------- */

  /**
   * What a shared link (?q=...) asks for. Text or a link, cleaned and capped.
   * It NEVER asks for a model call: a crafted link must not spend anyone's
   * credit, so the page runs the free quick scan and waits for a tap.
   */
  function parseQ(search) {
    var params;
    try { params = new URLSearchParams(String(search || '').replace(/^\?/, '')); } catch (e) { return null; }
    var raw = params.get('q');
    if (raw == null) return null;
    var cut = params.get('cut') === '1';
    var v = clean(raw).trim();
    if (!v) return null;
    var src = ({ bm: 'bookmarklet', shortcut: 'shortcut', ext: 'extension' })[params.get('src')] || null;
    if (/^https?:\/\/\S+$/i.test(v) && v.length <= LIMITS.url) {
      return { kind: 'link', value: v, https: /^https:/i.test(v), cut: false, src: src, autoSpend: false };
    }
    if (v.length > LIMITS.text) { v = v.slice(0, LIMITS.text); cut = true; }
    return { kind: 'text', value: v, cut: cut, src: src, autoSpend: false };
  }

  /* ---------------- a plain-text summary (Shortcut, extension) ---------------- */

  function plainSummary(r) {
    r = r || {};
    var lines = [];
    var c = combine({ quick: r.quick, deep: r.deep, meta: r.meta, visual: r.visual });
    if (c) lines.push('Reads as AI: ' + c.score + '/100 (' + c.lo + '–' + c.hi + ', ' + c.confidence + ' confidence). ' + levelWord(c.score) + '.');
    (r.meta && r.meta.findings || []).forEach(function (f) { lines.push((f.strength === 'strong' ? 'Strong: ' : f.points === 'camera' ? 'Camera: ' : 'Note: ') + f.label + (f.detail ? ' — ' + f.detail : '')); });
    if (r.meta && !(r.meta.findings || []).some(function (f) { return f.points !== 'none'; })) lines.push('Metadata: none found. ' + METADATA_NOTE);
    if (r.visual) {
      lines.push('Visual read (weak): ' + r.visual.likelihood + '/100, ' + r.visual.confidence + ' confidence. ' + (r.visual.summary || ''));
      (r.visual.artefacts || []).slice(0, 4).forEach(function (a) { lines.push(' - ' + (a.frame != null ? 'Frame ' + (a.frame + 1) + ', ' : '') + a.where + ': ' + a.what); });
    }
    if (r.deep) {
      lines.push('Deep read: ' + (r.deep.summary || ''));
      (r.deep.spans || []).slice(0, 4).forEach(function (s) { lines.push(' - “' + s.quote.slice(0, 80) + '” ' + s.reason); });
    } else if (r.quick) {
      (r.quick.hits || []).filter(function (h) { return h.counted; }).slice(0, 4).forEach(function (h) { lines.push(' - “' + h.quote.slice(0, 60) + '” ' + h.label); });
    }
    if (r.originality) {
      lines.push('Originality: ' + r.originality.score + '/100 (' + r.originality.confidence + ' confidence).');
      if (!(r.originality.sources || []).length) lines.push(ORIGINAL_NONE);
      (r.originality.sources || []).slice(0, 3).forEach(function (s) { lines.push(' - ' + s.title + ' (' + s.overlap + ') ' + s.url); });
    }
    lines.push(r.visual && !r.deep ? VISUAL_NOTE : LIMITS_LINE);
    return lines.join('\n');
  }

  return {
    VERSION: VERSION, LIMITS: LIMITS, LIMITS_LINE: LIMITS_LINE, METADATA_NOTE: METADATA_NOTE,
    VISUAL_NOTE: VISUAL_NOTE, ORIGINAL_NONE: ORIGINAL_NONE, CATEGORIES: CATEGORIES, RULES: RULES,
    scan: scan, segments: segments, combine: combine, levelWord: levelWord, strongest: strongest,
    parseQ: parseQ, plainSummary: plainSummary, clean: clean, escapeHtml: escapeHtml, words: words,
  };
}));
