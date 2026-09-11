import fs from 'node:fs';
import zlib from 'node:zlib';

function decode(file) {
  const buf = fs.readFileSync(file);
  let off = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h, depth, color } = ihdr;
  const bits = { 0: depth, 2: depth * 3, 3: depth, 4: depth * 2, 6: depth * 4 }[color];
  const bpp = Math.max(1, Math.ceil(bits / 8));
  const stride = Math.ceil((w * bits) / 8);
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  const alpha = (x, y) => {
    const i = y * stride + x * bpp;
    if (color === 6) return out[i + 3];
    if (color === 2 || color === 0) return 255;
    if (color === 4) return out[i + 1];
    const bi = y * stride + (depth === 8 ? x : (x >> 1));
    const idx = depth === 8 ? out[bi] : ((x & 1) ? (out[bi] & 0x0f) : (out[bi] >> 4));
    return trns && idx < trns.length ? trns[idx] : 255;
  };
  return { w, h, alpha };
}

const file = process.argv[2];
const y0 = parseInt(process.argv[3] || '16', 10);
const y1 = parseInt(process.argv[4] || '31', 10);
const { w, h, alpha } = decode(file);
console.log(file + '  ' + w + 'x' + h + '  行区间 y=' + y0 + '..' + y1);
let row = 'x:   ';
for (let x = 0; x < w; x++) row += x % 10 === 0 ? '|' : ' ';
console.log(row);
let fill = 'fill:';
for (let x = 0; x < w; x++) {
  let n = 0;
  for (let y = y0; y <= y1 && y < h; y++) if (alpha(x, y) > 16) n++;
  const r = n / (y1 - y0 + 1);
  fill += r > 0.85 ? '#' : r > 0.4 ? '+' : r > 0.05 ? '.' : '_';
}
console.log(fill);
console.log('     0        1        2        3        4        5        6');
console.log('     0123456789012345678901234567890123456789012345678901234567890123');
