import fs from 'node:fs';
import zlib from 'node:zlib';
import { writePNG } from './pngenc.mjs';

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
  const px = (x, y) => {
    const i = y * stride + x * bpp;
    if (color === 6) return [out[i], out[i + 1], out[i + 2], out[i + 3]];
    if (color === 2) return [out[i], out[i + 1], out[i + 2], 255];
    if (color === 0) { const g = out[i]; return [g, g, g, 255]; }
    if (color === 4) { const g = out[i]; return [g, g, g, out[i + 1]]; }
    const bi = y * stride + (depth === 8 ? x : (x >> 1));
    const idx = depth === 8 ? out[bi] : ((x & 1) ? (out[bi] & 0x0f) : (out[bi] >> 4));
    const a = trns && idx < trns.length ? trns[idx] : 255;
    return [plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2], a];
  };
  return { w, h, px };
}

const file = process.argv[2];
const img = decode(file);
const scale = 16;
const W = img.w * scale, H = img.h * scale;
const buf = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const sx = (x / scale) | 0, sy = (y / scale) | 0;
    const c = img.px(sx, sy);
    const chk = (sx + sy) & 1;
    const base = chk ? [110, 110, 120] : [70, 70, 80];
    const a = c[3] / 255;
    const o = (y * W + x) * 4;
    let v0 = c[0] * a + base[0] * (1 - a);
    let v1 = c[1] * a + base[1] * (1 - a);
    let v2 = c[2] * a + base[2] * (1 - a);
    if (sx % 8 === 0 && sy % 8 === 0) {
      v0 = 30; v1 = 30; v2 = 60;
    } else if (sx % 4 === 0 || sy % 4 === 0) {
      v0 = v0 * 0.6 + 50; v1 = v1 * 0.6 + 50; v2 = v2 * 0.6 + 80;
    }
    buf[o] = Math.max(0, Math.min(255, v0 | 0));
    buf[o + 1] = Math.max(0, Math.min(255, v1 | 0));
    buf[o + 2] = Math.max(0, Math.min(255, v2 | 0));
    buf[o + 3] = 255;
  }
}
const out = 'screenshots/gridview-' + (file.match(/entity\/(\w+)\.png/)?.[1] || 'tex') + '.png';
writePNG(out, W, H, buf);
console.log(out + '  ' + W + 'x' + H);