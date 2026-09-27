// Small synthetic files, built byte by byte, for the metadata scanner's
// tests. Each carries exactly the structure a real one would (segment
// lengths, chunk CRC slots, box sizes), so the scanner walks them the way it
// walks a camera's or a generator's output - just without any pixels.

function u16be(n) { return Buffer.from([(n >> 8) & 255, n & 255]); }
function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

/** A CBOR text string: the header byte(s), then UTF-8. */
function cbor(str) {
  const b = Buffer.from(str);
  if (b.length < 24) return Buffer.concat([Buffer.from([0x60 + b.length]), b]);
  if (b.length < 256) return Buffer.concat([Buffer.from([0x78, b.length]), b]);
  return Buffer.concat([Buffer.from([0x79, b.length >> 8, b.length & 255]), b]);
}
/** A claim: claim_generator, then whatever else (actions, source type). */
function claim(generator, ...rest) {
  return Buffer.concat([cbor('claim_generator'), cbor(generator), ...rest.map(cbor)]).toString('latin1');
}

/* ---------------- JPEG ---------------- */

function segment(marker, payload) {
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
}
function jpeg(...segments) {
  // SOI, the segments, then a scrap of "image data" and EOI.
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), Buffer.alloc(64, 0x55), Buffer.from([0xff, 0xd9])]);
}

/** A JUMBF superbox labelled c2pa with a CBOR-ish claim inside. */
function jumbf(claimText) {
  const label = Buffer.from('c2pa\u0000');
  const jumdPayload = Buffer.concat([Buffer.from('6332706100110010800000aa00389b71', 'hex'), Buffer.from([0x03]), label]);
  const jumd = Buffer.concat([u32be(8 + jumdPayload.length), Buffer.from('jumd'), jumdPayload]);
  const cbor = Buffer.from(claimText, 'latin1');
  const cborBox = Buffer.concat([u32be(8 + cbor.length), Buffer.from('cbor'), cbor]);
  const inner = Buffer.concat([jumd, cborBox]);
  return Buffer.concat([u32be(8 + inner.length), Buffer.from('jumb'), inner]);
}
function app11(box) {
  // JPEG APP11 JUMBF: "JP", box instance 1, sequence 1, then the box.
  return segment(0xeb, Buffer.concat([Buffer.from('JP'), u16be(1), u32be(1), box]));
}

/** A big-endian TIFF with IFD0 ASCII tags and an Exif IFD. */
function tiff({ make, model, software, dateOriginal, lens }) {
  const ifd0 = [];
  if (make) ifd0.push([0x010f, make]);
  if (model) ifd0.push([0x0110, model]);
  if (software) ifd0.push([0x0131, software]);
  const exif = [];
  if (dateOriginal) exif.push([0x9003, dateOriginal]);
  if (lens) exif.push([0xa434, lens]);
  const header = Buffer.concat([Buffer.from('MM'), u16be(42), u32be(8)]);
  const n0 = ifd0.length + (exif.length ? 1 : 0);
  const ifd0Size = 2 + n0 * 12 + 4;
  const exifStart = 8 + ifd0Size;
  const exifSize = exif.length ? 2 + exif.length * 12 + 4 : 0;
  let dataAt = exifStart + exifSize;
  const data = [];
  const entry = (tag, str) => {
    const bytes = Buffer.from(str + '\u0000', 'latin1');
    const e = Buffer.concat([u16be(tag), u16be(2), u32be(bytes.length)]);
    if (bytes.length <= 4) return Buffer.concat([e, bytes, Buffer.alloc(4 - bytes.length)]);
    const off = dataAt; dataAt += bytes.length; data.push(bytes);
    return Buffer.concat([e, u32be(off)]);
  };
  const e0 = ifd0.map(([t, s]) => entry(t, s));
  if (exif.length) e0.push(Buffer.concat([u16be(0x8769), u16be(4), u32be(1), u32be(exifStart)]));
  const e1 = exif.map(([t, s]) => entry(t, s));
  return Buffer.concat([
    header, u16be(n0), ...e0, u32be(0),
    ...(exif.length ? [u16be(exif.length), ...e1, u32be(0)] : []),
    ...data,
  ]);
}
function app1Exif(fields) { return segment(0xe1, Buffer.concat([Buffer.from('Exif\u0000\u0000'), tiff(fields)])); }
function app1Xmp(xml) { return segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\u0000'), Buffer.from(xml)])); }

/* ---------------- PNG ---------------- */

function chunk(type, data) { return Buffer.concat([u32be(data.length), Buffer.from(type), data, Buffer.alloc(4)]); }
function png(...chunks) {
  const ihdr = chunk('IHDR', Buffer.concat([u32be(1), u32be(1), Buffer.from([8, 2, 0, 0, 0])]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, ...chunks, chunk('IDAT', Buffer.alloc(12)), chunk('IEND', Buffer.alloc(0))]);
}
function tEXt(key, value) { return chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')])); }
function iTXt(key, value) { return chunk('iTXt', Buffer.concat([Buffer.from(key), Buffer.from([0, 0, 0]), Buffer.from([0]), Buffer.from([0]), Buffer.from(value)])); }

/* ---------------- MP4 ---------------- */

function box(type, payload) { return Buffer.concat([u32be(8 + payload.length), Buffer.from(type, 'latin1'), payload]); }
function mp4({ c2paClaim, encoder } = {}) {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32be(512), Buffer.from('isomiso2mp41')]));
  const parts = [ftyp];
  if (c2paClaim) parts.push(box('uuid', Buffer.concat([Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex'), u32be(0), jumbf(c2paClaim)])));
  const udta = encoder ? box('udta', box('©too', Buffer.concat([u16be(encoder.length), u16be(0), Buffer.from(encoder)]))) : Buffer.alloc(0);
  parts.push(box('moov', Buffer.concat([box('mvhd', Buffer.alloc(100)), udta])));
  parts.push(box('mdat', Buffer.alloc(256, 0x11)));
  return Buffer.concat(parts);
}

const XMP_AI = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
const XMP_CAMERA = XMP_AI.replace('trainedAlgorithmicMedia', 'digitalCapture');

module.exports = { cbor, claim, jpeg, segment, jumbf, app11, app1Exif, app1Xmp, tiff, png, chunk, tEXt, iTXt, mp4, box, XMP_AI, XMP_CAMERA, u32le };
