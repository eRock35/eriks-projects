/* Tells - the metadata scanner. Pure, free, no network, no model.
 *
 * Given the ORIGINAL bytes of a picture or video (a canvas redraw strips all
 * of this), it reports what the file says about where it came from:
 *
 *   - C2PA / Content Credentials: JUMBF boxes labelled "c2pa", in JPEG APP11,
 *     PNG caBX, RIFF/WebP "C2PA" and ISO-BMFF (MP4/MOV/HEIC) uuid boxes. We
 *     read the readable strings (claim generator, software agent, actions,
 *     digital source type). We do NOT check the manifest's signature: the
 *     page says "found (not verified here)" and links to the official
 *     verifier. A manifest naming an AI generator is the one STRONG signal.
 *   - IPTC/XMP DigitalSourceType: trainedAlgorithmicMedia and friends
 *     (strong), digitalCapture (points to a camera).
 *   - PNG text chunks: Automatic1111 "parameters", ComfyUI "prompt"/"workflow",
 *     InvokeAI, and Software/Description naming a generator (strong).
 *   - EXIF Make/Model/DateTimeOriginal/Lens (a camera, weak - it is trivial
 *     to write) and EXIF Software naming a generator (strong).
 *
 * Nothing found is reported honestly: most platforms strip metadata on
 * upload, so absence means nothing either way.
 *
 * UMD, like tells-core.js: window.TellsMeta in the page, require() on the
 * server and in tests, a byte-identical copy in the Chrome extension.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TellsMeta = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERIFY_URL = 'https://contentcredentials.org/verify';
  var NOTE_NONE = 'Most platforms strip metadata on upload, so finding none means nothing either way.';
  var NOTE_C2PA = 'We read the Content Credentials but do not verify their signature. Check the file at contentcredentials.org/verify.';
  var MAX_REGION = 4 * 1024 * 1024;   // text-scanned per metadata region
  var MAX_GENERIC = 24 * 1024 * 1024;  // generic scan over a whole buffer
  var C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
  var XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

  // Generators, by the name they write. Checked only inside metadata fields,
  // never against pixel data, so a random "flux" in a JPEG's image stream is
  // never read.
  var AI_NAMES = [
    ['OpenAI', /\bopenai\b/i], ['DALL·E', /\bdall[\s·.\-_]?e\b/i], ['ChatGPT', /\bchatgpt\b/i], ['Sora', /\bsora\b/i],
    ['Adobe Firefly', /\bfirefly\b/i], ['Midjourney', /\bmidjourney\b/i],
    ['Stable Diffusion', /stable[\s_-]?diffusion|\bsdxl\b/i], ['NovelAI', /\bnovelai\b/i],
    ['Leonardo.Ai', /\bleonardo(?:\.ai|\s?ai)\b/i], ['Ideogram', /\bideogram\b/i], ['Google Imagen', /\bimagen\b/i],
    ['Google Gemini', /\bgemini\b/i], ['Flux', /\bflux(?:\.1)?\b|black[\s-]?forest[\s-]?labs/i],
    ['Grok / Aurora', /\bgrok\b|\bxai aurora\b/i], ['Microsoft Designer', /microsoft designer|bing image creator|designer\.microsoft/i],
    ['Runway', /\brunwayml\b|\brunway (?:gen|ml)/i], ['Pika', /\bpika labs\b|\bpika\.art\b/i], ['Kling', /\bkling\b/i],
    ['Google Veo', /\bveo ?\d?\b/i], ['ComfyUI', /\bcomfyui\b/i], ['Automatic1111', /automatic1111/i],
    ['InvokeAI', /\binvokeai\b/i], ['Fooocus', /\bfooocus\b/i], ['Canva AI', /\bcanva (?:ai|magic)/i],
  ];
  var SOURCE_TYPES = {
    trainedalgorithmicmedia: { points: 'ai', strength: 'strong', label: 'Made by a generative AI model', code: 'trainedAlgorithmicMedia' },
    compositewithtrainedalgorithmicmedia: { points: 'ai', strength: 'strong', label: 'Made partly with generative AI', code: 'compositeWithTrainedAlgorithmicMedia' },
    algorithmicmedia: { points: 'ai', strength: 'strong', label: 'Made by an algorithm, not a camera', code: 'algorithmicMedia' },
    compositesynthetic: { points: 'ai', strength: 'strong', label: 'A composite that includes synthetic parts', code: 'compositeSynthetic' },
    digitalcapture: { points: 'camera', strength: 'weak', label: 'Says it was captured by a camera', code: 'digitalCapture' },
    negativefilm: { points: 'camera', strength: 'weak', label: 'Says it was scanned from film', code: 'negativeFilm' },
    positivefilm: { points: 'camera', strength: 'weak', label: 'Says it was scanned from film', code: 'positiveFilm' },
  };

  /* ---------------- bytes ---------------- */

  function u8(x) {
    if (x instanceof Uint8Array) return x;
    if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    return new Uint8Array(0);
  }
  function be16(b, i) { return (b[i] << 8) | b[i + 1]; }
  function be32(b, i) { return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]); }
  function le32(b, i) { return ((b[i + 3] << 24) >>> 0) + ((b[i + 2] << 16) | (b[i + 1] << 8) | b[i]); }
  function ascii(b, s, e) {
    var out = '';
    e = Math.min(e, b.length);
    for (var i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 8192)));
    return out;
  }
  function utf8(b, s, e) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(s, Math.min(e, b.length))); } catch (err) { return ascii(b, s, e); }
  }
  function hex(b, s, n) {
    var out = '';
    for (var i = s; i < s + n && i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }
  function indexOfBytes(b, needle, from, to) {
    var n = needle.length, first = needle.charCodeAt(0);
    to = Math.min(to == null ? b.length : to, b.length) - n;
    outer: for (var i = from || 0; i <= to; i++) {
      if (b[i] !== first) continue;
      for (var j = 1; j < n; j++) if (b[i + j] !== needle.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }
  function tidy(s, max) {
    s = String(s || '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > (max || 120) ? s.slice(0, (max || 120) - 1) + '…' : s;
  }

  function sniff(b) {
    b = u8(b);
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'image/png';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
    if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return 'image/gif';
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
    if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
      var brand = ascii(b, 8, 12);
      if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
      if (/^avi[fs]$/.test(brand)) return 'image/avif';
      if (brand === 'qt  ') return 'video/quicktime';
      return 'video/mp4';
    }
    return null;
  }

  /* ---------------- ISO-BMFF boxes (MP4, MOV, HEIC) ---------------- */

  /** Top-level boxes whose headers lie inside `b` (offset `base` in the
   *  file). Sizes may run past the end of `b`: the browser uses this to fetch
   *  just the uuid and moov boxes of a large video. */
  function bmffBoxes(b, base, max) {
    b = u8(b); base = base || 0;
    var out = [], i = 0;
    while (i + 8 <= b.length && out.length < (max || 200)) {
      var size = be32(b, i), type = ascii(b, i + 4, i + 8), head = 8;
      if (!/^[\x20-\x7e©]{4}$/.test(type)) break;
      if (size === 1) {
        if (i + 16 > b.length) break;
        size = be32(b, i + 8) * 4294967296 + be32(b, i + 12); head = 16;
      } else if (size === 0) size = Infinity;
      if (size < head) break;
      var box = { type: type, start: base + i, size: size, head: head };
      if (type === 'uuid' && i + head + 16 <= b.length) box.uuid = hex(b, i + head, 16);
      out.push(box);
      if (!isFinite(size)) break;
      i += size;
    }
    return out;
  }

  /* ---------------- EXIF (TIFF) ---------------- */

  var TIFF_TAGS = { 0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x0132: 'DateTime', 0x010e: 'ImageDescription', 0x013b: 'Artist' };
  var EXIF_TAGS = { 0x9003: 'DateTimeOriginal', 0xa433: 'LensMake', 0xa434: 'LensModel' };

  function tiff(b, s, e) {
    var out = {};
    if (s + 8 > e) return out;
    var le = b[s] === 0x49 && b[s + 1] === 0x49;
    if (!le && !(b[s] === 0x4d && b[s + 1] === 0x4d)) return out;
    var r16 = function (i) { return le ? (b[i] | (b[i + 1] << 8)) : be16(b, i); };
    var r32 = function (i) { return le ? le32(b, i) : be32(b, i); };
    if (r16(s + 2) !== 42) return out;
    function ifd(off, tags, depth) {
      var p = s + off;
      if (off < 8 || p + 2 > e || depth > 2) return;
      var n = Math.min(r16(p), 400);
      for (var k = 0; k < n; k++) {
        var q = p + 2 + k * 12;
        if (q + 12 > e) return;
        var tag = r16(q), type = r16(q + 2), count = r32(q + 4);
        if (tag === 0x8769 && depth === 0) { ifd(r32(q + 8), EXIF_TAGS, depth + 1); continue; }
        if (!tags[tag] || type !== 2) continue;
        count = Math.min(count, 512);
        var at = count <= 4 ? q + 8 : s + r32(q + 8);
        if (at + count > e) continue;
        out[tags[tag]] = tidy(ascii(b, at, at + count).replace(/\u0000+$/, ''), 120);
      }
    }
    ifd(r32(s + 4), TIFF_TAGS, 0);
    return out;
  }

  /* ---------------- the collector ---------------- */

  function Collector(size) {
    this.findings = []; this.regions = []; this.format = null; this.size = size; this.seen = {};
    this.exif = {}; this.c2pa = false; this.structure = [];
  }
  Collector.prototype.add = function (f) {
    var key = f.id + '|' + f.label + '|' + (f.detail || '');
    if (this.seen[key]) return;
    this.seen[key] = true;
    this.findings.push(f);
  };

  function aiNamesIn(s) {
    var names = [];
    AI_NAMES.forEach(function (n) { if (n[1].test(s) && names.indexOf(n[0]) < 0) names.push(n[0]); });
    return names;
  }

  function sourceTypes(c, s, where) {
    var re = /digitalsourcetype[\s\S]{0,160}?(trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmicMedia|compositeSynthetic|digitalCapture|negativeFilm|positiveFilm)/gi;
    var loose = /(compositeWithTrainedAlgorithmicMedia|trainedAlgorithmicMedia)/gi;
    var m, found = {};
    while ((m = re.exec(s))) found[m[1].toLowerCase()] = true;
    while ((m = loose.exec(s))) found[m[1].toLowerCase()] = true;
    if (found.compositewithtrainedalgorithmicmedia) delete found.trainedalgorithmicmedia;
    Object.keys(found).forEach(function (k) {
      var t = SOURCE_TYPES[k];
      if (!t) return;
      c.add({ id: 'source-type', strength: t.strength, points: t.points, label: t.label, detail: 'Digital source type: ' + t.code + ' (' + where + ')', where: where });
    });
  }

  function xmp(c, s) {
    c.structure.push('XMP');
    sourceTypes(c, s, 'XMP');
    var tools = [];
    var re = /(?:xmp:CreatorTool|stEvt:softwareAgent|tiff:Software|exif:Software|photoshop:Credit)\s*(?:=\s*"([^"]{1,200})"|>([^<]{1,200})<)/gi, m;
    while ((m = re.exec(s))) tools.push(tidy(m[1] || m[2], 100));
    tools.forEach(function (t) {
      var names = aiNamesIn(t);
      if (names.length) c.add({ id: 'xmp-tool', strength: 'strong', points: 'ai', label: 'The editing history names ' + names.join(', '), detail: 'XMP software: ' + t, where: 'XMP' });
    });
    if (/Made with AI|AI[- ]generated|Generated with AI/i.test(s)) {
      c.add({ id: 'xmp-label', strength: 'strong', points: 'ai', label: 'The metadata labels it as made with AI', detail: 'XMP text', where: 'XMP' });
    }
  }

  /** The CBOR text string that follows `key` (itself a CBOR text), or ''.
   *  C2PA claims are CBOR; strings in them are a one-to-three byte header
   *  (major type 3) and then the text. Reading the header rather than
   *  "printable characters after the key" matters: a short string's header
   *  byte is itself printable (0x6a is "j"). */
  function cborTextAfter(str, key, from) {
    var i = str.indexOf(key, from || 0);
    if (i < 0) return '';
    var p = i + key.length, h = str.charCodeAt(p), len = -1, s = p + 1;
    if (h >= 0x60 && h <= 0x77) len = h - 0x60;
    else if (h === 0x78) { len = str.charCodeAt(p + 1); s = p + 2; }
    else if (h === 0x79) { len = (str.charCodeAt(p + 1) << 8) | str.charCodeAt(p + 2); s = p + 3; }
    if (len < 1 || len > 400 || s + len > str.length) return '';
    var raw = str.slice(s, s + len);
    try { raw = decodeURIComponent(escape(raw)); } catch (e) { /* not UTF-8: keep the bytes */ }
    return tidy(raw, 100);
  }

  /** Every CBOR text string in a region, by walking headers: the names a
   *  manifest carries, cut apart so a header byte glued to "Sora" (0x64 is
   *  "d") cannot hide it from a word-boundary match. */
  function cborStrings(str) {
    var out = [];
    for (var i = 0; i < str.length && out.length < 2000; i++) {
      var h = str.charCodeAt(i), len = -1, s = i + 1;
      if (h >= 0x63 && h <= 0x77) len = h - 0x60;
      else if (h === 0x78) { len = str.charCodeAt(i + 1); s = i + 2; }
      if (len < 3 || s + len > str.length) continue;
      var t = str.slice(s, s + len);
      if (/^[\x20-\x7e\u00a0-\u00ff]+$/.test(t)) { out.push(t); i = s + len - 1; }
    }
    return out;
  }

  function c2pa(c, b, s, e, where) {
    var str = ascii(b, s, Math.min(e, s + MAX_REGION));
    if (!/c2pa/i.test(str) && !/jumd|jumb/.test(str)) return;
    c.c2pa = true;
    c.structure.push('C2PA (' + where + ')');
    var gen = cborTextAfter(str, 'claim_generator', 0);
    var info = str.indexOf('claim_generator_info');
    if (!gen && info >= 0) gen = cborTextAfter(str, 'name', info);
    var agents = [];
    var at = 0, guard = 0;
    while ((at = str.indexOf('softwareAgent', at)) >= 0 && agents.length < 5 && guard++ < 50) {
      var h = str.charCodeAt(at + 13);
      var t = h >= 0xa0 && h <= 0xb7 ? cborTextAfter(str.slice(at, at + 200), 'name', 0) : cborTextAfter(str, 'softwareAgent', at);
      if (t && agents.indexOf(t) < 0) agents.push(t);
      at += 13;
    }
    var names = aiNamesIn(cborStrings(str).join(' \n ') + ' \n ' + str);
    var created = /c2pa\.created/.test(str);
    var ai = /trainedAlgorithmicMedia|algorithmicMedia/i.test(str);
    var detail = [gen && 'Claim generator: ' + gen, agents.length && 'Software: ' + agents.join(', '), created && 'Action: created'].filter(Boolean).join(' · ');
    if (names.length || ai) {
      c.add({
        id: 'c2pa', strength: 'strong', points: 'ai', where: where, verify: VERIFY_URL,
        label: 'Content Credentials name ' + (names.length ? names.join(', ') : 'a generative AI source') + ' (not verified here)',
        detail: detail || 'C2PA manifest',
      });
    } else {
      c.add({ id: 'c2pa', strength: 'info', points: 'none', where: where, verify: VERIFY_URL, label: 'Content Credentials found (not verified here)', detail: detail || 'C2PA manifest' });
    }
    sourceTypes(c, str, 'Content Credentials');
  }

  function exifFindings(c, ex, where) {
    if (!ex || !Object.keys(ex).length) return;
    c.structure.push('EXIF');
    Object.keys(ex).forEach(function (k) { c.exif[k] = ex[k]; });
    var sw = ex.Software || '';
    var names = aiNamesIn(sw + ' ' + (ex.ImageDescription || '') + ' ' + (ex.Artist || ''));
    if (names.length) c.add({ id: 'exif-software', strength: 'strong', points: 'ai', label: 'The file says it was made with ' + names.join(', '), detail: 'EXIF: ' + tidy(sw || ex.ImageDescription || ex.Artist, 80), where: where });
    if (ex.Make || ex.Model) {
      var cam = tidy([ex.Make, ex.Model].filter(Boolean).join(' '), 80);
      var bits = [ex.DateTimeOriginal && 'taken ' + ex.DateTimeOriginal, ex.LensModel && 'lens ' + ex.LensModel].filter(Boolean);
      c.add({ id: 'exif-camera', strength: 'weak', points: 'camera', label: 'Camera details: ' + cam, detail: (bits.length ? bits.join(', ') + '. ' : '') + 'Points to a camera, but EXIF is easy to write, so it is not proof.', where: where });
    } else if (sw && !names.length) {
      c.add({ id: 'exif-software', strength: 'info', points: 'none', label: 'Edited or saved with ' + tidy(sw, 60), detail: 'EXIF software', where: where });
    }
  }

  function pngText(c, key, val) {
    var k = key.toLowerCase();
    var v = String(val || '');
    if (k === 'xml:com.adobe.xmp') return xmp(c, v);
    if (k === 'parameters' && /steps:|sampler|cfg scale|seed:/i.test(v)) {
      c.add({ id: 'png-a1111', strength: 'strong', points: 'ai', label: 'Stable Diffusion generation settings (Automatic1111-style)', detail: 'PNG text “parameters”: ' + tidy(v, 90), where: 'PNG text' });
    } else if ((k === 'prompt' || k === 'workflow') && /[{[]/.test(v.slice(0, 5))) {
      c.add({ id: 'png-comfy', strength: 'strong', points: 'ai', label: 'A ComfyUI generation graph', detail: 'PNG text “' + key + '”', where: 'PNG text' });
    } else if (k === 'dream' || k === 'sd-metadata' || k === 'invokeai_metadata' || k === 'invokeai_graph') {
      c.add({ id: 'png-invoke', strength: 'strong', points: 'ai', label: 'InvokeAI generation settings', detail: 'PNG text “' + key + '”', where: 'PNG text' });
    } else {
      var names = aiNamesIn(v);
      if (names.length && /^(software|description|comment|source|author|title|generation time|creation time)$/i.test(key)) {
        c.add({ id: 'png-software', strength: 'strong', points: 'ai', label: 'The file names ' + names.join(', '), detail: 'PNG text “' + key + '”: ' + tidy(v, 80), where: 'PNG text' });
      } else if (k === 'parameters') {
        c.add({ id: 'png-a1111', strength: 'strong', points: 'ai', label: 'Image-generator settings in the file', detail: 'PNG text “parameters”: ' + tidy(v, 90), where: 'PNG text' });
      }
    }
    sourceTypes(c, v, 'PNG text');
  }

  /* ---------------- per format ---------------- */

  function jpeg(c, b) {
    var i = 2, guard = 0;
    while (i + 4 <= b.length && guard++ < 500) {
      if (b[i] !== 0xff) break;
      var marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      var len = be16(b, i + 2), s = i + 4, e = Math.min(i + 2 + len, b.length);
      if (len < 2) break;
      if (marker === 0xe1) {
        if (ascii(b, s, s + 6) === 'Exif\u0000\u0000') exifFindings(c, tiff(b, s + 6, e), 'EXIF');
        else if (ascii(b, s, s + 29) === 'http://ns.adobe.com/xap/1.0/\u0000') xmp(c, utf8(b, s + 29, e));
        else if (/^http:\/\/ns\.adobe\.com\/xmp\/extension\//.test(ascii(b, s, s + 40))) xmp(c, utf8(b, s, e));
      } else if (marker === 0xeb) {
        c2pa(c, b, s, e, 'JPEG APP11');
      } else if (marker === 0xfe) {
        var com = utf8(b, s, e), names = aiNamesIn(com);
        if (names.length) c.add({ id: 'jpeg-comment', strength: 'strong', points: 'ai', label: 'The file comment names ' + names.join(', '), detail: tidy(com, 80), where: 'JPEG comment' });
      }
      i = i + 2 + len;
    }
  }

  function png(c, b) {
    var i = 8, guard = 0;
    while (i + 12 <= b.length && guard++ < 10000) {
      var len = be32(b, i), type = ascii(b, i + 4, i + 8), s = i + 8, e = Math.min(s + len, b.length);
      if (type === 'IEND') break;
      if (type === 'tEXt') {
        var z = b.indexOf(0, s);
        if (z > s && z < e) pngText(c, ascii(b, s, z), ascii(b, z + 1, e));
      } else if (type === 'iTXt') {
        var z1 = b.indexOf(0, s);
        if (z1 > s && z1 < e) {
          var key = ascii(b, s, z1), comp = b[z1 + 1];
          var z2 = b.indexOf(0, z1 + 3), z3 = z2 >= 0 ? b.indexOf(0, z2 + 1) : -1;
          if (comp === 0 && z3 > 0 && z3 < e) pngText(c, key, utf8(b, z3 + 1, e));
          else if (comp === 1) c.structure.push('compressed text “' + tidy(key, 30) + '” (not read)');
        }
      } else if (type === 'zTXt') {
        var z4 = b.indexOf(0, s);
        if (z4 > s && z4 < e) {
          var zk = ascii(b, s, z4);
          if (/^(parameters|prompt|workflow)$/i.test(zk)) c.add({ id: 'png-compressed', strength: 'strong', points: 'ai', label: 'Image-generator settings in the file (compressed “' + tidy(zk, 20) + '”)', detail: 'PNG zTXt', where: 'PNG text' });
        }
      } else if (type === 'eXIf') exifFindings(c, tiff(b, s, e), 'EXIF');
      else if (type === 'caBX') c2pa(c, b, s, e, 'PNG caBX');
      i = s + len + 4;
    }
  }

  function riff(c, b) {
    var i = 12, guard = 0;
    while (i + 8 <= b.length && guard++ < 1000) {
      var type = ascii(b, i, i + 4), len = le32(b, i + 4), s = i + 8, e = Math.min(s + len, b.length);
      if (type === 'EXIF') exifFindings(c, tiff(b, ascii(b, s, s + 6) === 'Exif\u0000\u0000' ? s + 6 : s, e), 'EXIF');
      else if (type === 'XMP ') xmp(c, utf8(b, s, e));
      else if (type === 'C2PA') c2pa(c, b, s, e, 'WebP C2PA');
      i = s + len + (len & 1);
    }
  }

  function bmff(c, b, base) {
    bmffBoxes(b, base).forEach(function (box) {
      var s = box.start - base + box.head, e = Math.min(box.start - base + box.size, b.length);
      if (s >= b.length) return;
      if (box.type === 'uuid' && box.uuid === C2PA_UUID) c2pa(c, b, s + 16, e, 'MP4 uuid box');
      else if (box.type === 'uuid' && box.uuid === XMP_UUID) xmp(c, utf8(b, s + 16, Math.min(e, s + MAX_REGION)));
      else if (box.type === 'moov' || box.type === 'meta') generic(c, b, s, Math.min(e, s + MAX_REGION), box.type + ' box', true);
    });
  }

  /** Metadata packets anywhere in a range: XMP, C2PA labels, embedded EXIF. */
  function generic(c, b, s, e, where, encoder) {
    e = Math.min(e, s + MAX_GENERIC, b.length);
    var p = s, guard = 0;
    while ((p = indexOfBytes(b, '<x:xmpmeta', p, e)) >= 0 && guard++ < 20) {
      var end = indexOfBytes(b, '</x:xmpmeta>', p, Math.min(e, p + MAX_REGION));
      xmp(c, utf8(b, p, end > 0 ? end + 12 : Math.min(e, p + 65536)));
      p = end > 0 ? end : p + 10;
    }
    var q = s; guard = 0;
    while ((q = indexOfBytes(b, 'jumd', q, e)) >= 0 && guard++ < 20) {
      var lab = ascii(b, q, Math.min(e, q + 64));
      if (/c2pa/.test(lab)) { c2pa(c, b, Math.max(s, q - 8), Math.min(e, q + MAX_REGION), where); break; }
      q += 4;
    }
    var x = indexOfBytes(b, 'Exif\u0000\u0000', s, Math.min(e, s + 4 * 1024 * 1024));
    if (x >= 0) exifFindings(c, tiff(b, x + 6, Math.min(e, x + 6 + 65536)), 'EXIF');
    if (encoder) {
      var txt = ascii(b, s, Math.min(e, s + 262144));
      var tools = [];
      var re = /(?:©too|©swr|encoder|com\.apple\.quicktime\.software|software)[^\x20-\x7e]{0,16}([A-Za-z][\x20-\x7e]{2,80})/g, m;
      while ((m = re.exec(txt)) && tools.length < 6) tools.push(tidy(m[1], 60));
      tools.forEach(function (t) {
        var names = aiNamesIn(t);
        if (names.length) c.add({ id: 'video-encoder', strength: 'strong', points: 'ai', label: 'The file was written by ' + names.join(', '), detail: 'Encoder tag: ' + t, where: where });
      });
    }
  }

  /**
   * Scan a file, or parts of one.
   * @param input  a Uint8Array/ArrayBuffer of the whole file, or an array of
   *               {offset, bytes} chunks of a large one (video: head, tail,
   *               and its uuid/moov boxes).
   * @param opts   {size: total file size, name}
   */
  function scan(input, opts) {
    opts = opts || {};
    var chunks = Array.isArray(input) ? input.map(function (ch) { return { offset: ch.offset || 0, bytes: u8(ch.bytes), box: ch.box || null }; }) : [{ offset: 0, bytes: u8(input) }];
    var size = opts.size || chunks.reduce(function (m, ch) { return Math.max(m, ch.offset + ch.bytes.length); }, 0);
    var c = new Collector(size);
    var head = chunks.filter(function (ch) { return ch.offset === 0; })[0];
    c.format = head ? sniff(head.bytes) : null;
    var scanned = 0;
    chunks.forEach(function (ch) {
      var b = ch.bytes;
      scanned += b.length;
      try {
        if (ch.offset === 0 && c.format === 'image/jpeg') jpeg(c, b);
        else if (ch.offset === 0 && c.format === 'image/png') png(c, b);
        else if (ch.offset === 0 && c.format === 'image/webp') riff(c, b);
        else if (/^(video\/mp4|video\/quicktime|image\/heic|image\/avif)$/.test(c.format || '') && (ch.offset === 0 || ch.box)) {
          if (ch.offset === 0) bmff(c, b, 0);
          generic(c, b, 0, b.length, ch.box ? ch.box + ' box' : 'file', true);
        } else generic(c, b, 0, b.length, ch.offset === 0 ? 'file' : 'end of file', /video/.test(c.format || ''));
      } catch (err) { c.structure.push('unreadable part'); }
    });
    var ai = c.findings.some(function (f) { return f.points === 'ai' && f.strength === 'strong'; });
    var camera = c.findings.some(function (f) { return f.points === 'camera'; });
    var none = !c.findings.length;
    if (none) c.findings.push({ id: 'none', strength: 'info', points: 'none', label: 'No provenance metadata found', detail: NOTE_NONE, where: 'file' });
    c.findings.sort(function (a, b) { return rank(b) - rank(a); });
    return {
      format: c.format, size: size, c2pa: c.c2pa,
      points: ai && camera ? 'mixed' : ai ? 'ai' : camera ? 'camera' : 'none',
      findings: c.findings.slice(0, 20), exif: c.exif, structure: c.structure.slice(0, 12),
      scanned: { bytes: scanned, of: size, partial: scanned < size },
      notes: [c.c2pa ? NOTE_C2PA : null, none ? NOTE_NONE : null].filter(Boolean),
      verify: VERIFY_URL,
    };
  }
  function rank(f) { return (f.strength === 'strong' ? 30 : f.strength === 'weak' ? 20 : 10) + (f.points === 'ai' ? 3 : f.points === 'camera' ? 2 : 0); }

  /** Drop anything a hand-written or hostile client could put in a findings
   *  list: the server never trusts a browser's scan, it only re-shapes it. */
  function cleanFindings(list) {
    return (Array.isArray(list) ? list : []).slice(0, 20).map(function (f) {
      f = f || {};
      return {
        id: tidy(f.id, 30), strength: ['strong', 'weak', 'info'].indexOf(f.strength) >= 0 ? f.strength : 'info',
        points: ['ai', 'camera', 'none'].indexOf(f.points) >= 0 ? f.points : 'none',
        label: tidy(f.label, 140), detail: tidy(f.detail, 200), where: tidy(f.where, 40),
      };
    }).filter(function (f) { return f.label; });
  }

  return {
    scan: scan, sniff: sniff, bmffBoxes: bmffBoxes, tiff: tiff, cleanFindings: cleanFindings, aiNamesIn: aiNamesIn,
    C2PA_UUID: C2PA_UUID, XMP_UUID: XMP_UUID, VERIFY_URL: VERIFY_URL, NOTE_NONE: NOTE_NONE, NOTE_C2PA: NOTE_C2PA,
  };
}));
