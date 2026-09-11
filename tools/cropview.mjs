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

function renderCrop(img, x, y, w, h, outFile, scale = 10) {
  const W = w * scale, H = h * scale;
  const buf = Buffer.alloc(W * H * 4);
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      const sx = x + ((xx / scale) | 0);
      const sy = y + ((yy / scale) | 0);
      const c = img.px(sx, sy);
      const chk = (((xx / scale) | 0) + ((yy / scale) | 0)) & 1;
      const base = chk ? [80, 80, 90] : [50, 50, 60];
      const a = c[3] / 255;
      const o = (yy * W + xx) * 4;
      const line = (((xx / scale) | 0) === 0 || ((yy / scale) | 0) === 0) ? 0.35 : 0;
      for (let k = 0; k < 3; k++) {
        let v = c[k] * a + base[k] * (1 - a);
        if (line) v = v * (1 - line) + 255 * line * 0.6;
        buf[o + k] = Math.max(0, Math.min(255, v | 0));
      }
      buf[o + 3] = 255;
    }
  }
  writePNG(outFile, W, H, buf);
  console.log(outFile + '  crop(' + x + ',' + y + ',' + w + ',' + h + ')');
}

const file = process.argv[2];
const img = decode(file);
const crops = process.argv.slice(3).map((s) => {
  const parts = s.split(',');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3]), parts[4] || 'x'];
});
for (const [x, y, w, h, label] of crops) {
  renderCrop(img, x, y, w, h, `screenshots/crop-${label}.png`);
}