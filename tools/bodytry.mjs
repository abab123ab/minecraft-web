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

function composeCustom(type, img, bodyRect) {
  const head = { pig: [8, 8, 8, 8], cow: [8, 8, 8, 8], sheep: [8, 8, 8, 8], chicken: [4, 4, 4, 6] }[type];
  const leg = { pig: [4, 20, 4, 6], cow: [4, 20, 4, 6], sheep: [4, 20, 4, 6], chicken: [30, 15, 2, 5] }[type];
  const peek = { pig: 2, cow: 2, sheep: 2, chicken: 1 }[type];
  const gap = 2;
  const legW = leg[2];
  const legTotal = legW * 2 + gap;
  const bodyY = peek === 0 ? head[3] : peek;
  const legY = bodyY + bodyRect[3] - 1;
  const w = Math.max(head[2], bodyRect[2], legTotal);
  const h = legY + leg[3];
  const grid = new Array(w * h).fill(null).map(() => [0, 0, 0, 0]);
  const put = (rect, dx, dy) => {
    for (let y = 0; y < rect[3]; y++) {
      for (let x = 0; x < rect[2]; x++) {
        const s = img.px(rect[0] + x, rect[1] + y);
        if (s[3] > 16) grid[(dy + y) * w + (dx + x)] = s;
      }
    }
  };
  put(bodyRect, ((w - bodyRect[2]) / 2) | 0, bodyY);
  const lx = ((w - legTotal) / 2) | 0;
  put(leg, lx, legY);
  put(leg, lx + legW + gap, legY);
  put(head, ((w - head[2]) / 2) | 0, 0);
  return { w, h, grid };
}

function render(grid, w, h, outFile, scale = 16) {
  const W = w * scale, H = h * scale;
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = (x / scale) | 0, sy = (y / scale) | 0;
      const c = grid[sy * w + sx];
      const chk = (sx + sy) & 1;
      const base = chk ? [120, 120, 130] : [80, 80, 90];
      const a = c[3] / 255;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        let v = c[k] * a + base[k] * (1 - a);
        buf[o + k] = Math.max(0, Math.min(255, v | 0));
      }
      buf[o + 3] = 255;
    }
  }
  writePNG(outFile, W, H, buf);
  console.log(outFile + '  ' + w + 'x' + h + ' -> ' + W + 'x' + H);
}

const type = process.argv[2];
const img = decode('../textures/entity/' + type + '.png');
const crops = process.argv.slice(3).map((s) => {
  const p = s.split(',');
  return { rect: [Number(p[0]), Number(p[1]), Number(p[2]), Number(p[3])], label: p[4] || 'x' };
});
for (const { rect, label } of crops) {
  const art = composeCustom(type, img, rect);
  render(art.grid, art.w, art.h, 'try-' + type + '-' + label + '.png');
  console.log('  ' + type + ' body(' + rect.join(',') + ') -> 画布 ' + art.w + 'x' + art.h + '  比例 ' + (art.w / art.h).toFixed(3));
}