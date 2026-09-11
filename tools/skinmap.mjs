import fs from 'node:fs';
import zlib from 'node:zlib';

function decode(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    } else if (type === 'PLTE') plte = Buffer.from(data);
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
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  const px = (x, y) => {
    const i = y * stride + x * bpp;
    if (color === 6) return [out[i], out[i + 1], out[i + 2], out[i + 3]];
    if (color === 2) return [out[i], out[i + 1], out[i + 2], 255];
    if (color === 4) return [out[i], out[i], out[i], out[i + 1]];
    if (color === 0) return [out[i], out[i], out[i], 255];
    const bi = y * stride + (depth === 8 ? x : (x >> 1));
    const idx = depth === 8 ? out[bi] : ((x & 1) ? (out[bi] & 0x0f) : (out[bi] >> 4));
    const a = trns && idx < trns.length ? trns[idx] : 255;
    return [plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2], a];
  };
  return { w, h, px };
}

const files = process.argv.slice(2);
for (const f of files) {
  const { w, h, px } = decode(f);
  console.log('\n=== ' + f + '  ' + w + 'x' + h + ' ===');
  const CELL = 2;
  let head = '     ';
  for (let x = 0; x < w; x += CELL) head += String(x % 10);
  console.log(head);
  for (let y = 0; y < h; y += CELL) {
    let line = String(y).padStart(3, ' ') + ' |';
    for (let x = 0; x < w; x += CELL) {
      let solid = 0, total = 0;
      for (let yy = y; yy < Math.min(y + CELL, h); yy++) {
        for (let xx = x; xx < Math.min(x + CELL, w); xx++) {
          total++;
          if (px(xx, yy)[3] > 16) solid++;
        }
      }
      const r = solid / total;
      line += r > 0.9 ? '#' : r > 0.5 ? '+' : r > 0.1 ? '.' : ' ';
    }
    console.log(line);
  }
}
