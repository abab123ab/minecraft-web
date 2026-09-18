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
  const px = (x, y) => {
    const i = y * stride + x * bpp;

    if (color === 6) return [out[i], out[i+1], out[i+2], out[i+3]];
    if (color === 2) return [out[i], out[i+1], out[i+2], 255];
    if (color === 0) return [out[i], out[i], out[i], 255];
    if (color === 4) return [out[i], out[i], out[i], out[i+1]];
    const bi = y * stride + (depth === 8 ? x : (x >> 1));
    const idx = depth === 8 ? out[bi] : ((x & 1) ? (out[bi] & 0x0f) : (out[bi] >> 4));
    return [plte[idx*3], plte[idx*3+1], plte[idx*3+2], (trns && idx < trns.length) ? trns[idx] : 255];
  };
  const alpha = (x, y) => px(x, y)[3];
  return { w, h, alpha, rgb: px };
}


const src = fs.readFileSync(new URL('../js/mobtex.js', import.meta.url), 'utf8');
const m = src.match(/const PART = (\{[\s\S]*?\n\});/);
const PART = eval('(' + m[1] + ')');
const dir = new URL('../textures/entity/', import.meta.url);
for (const k in PART) {
  const { w, h, alpha, rgb } = decode(new URL(k + '.png', dir));
  const parts = [];
  for (const part of ['head','body','leg']) {
    const [x,y,pw,ph] = PART[k][part];
    let n=0,tot=0,r=0,g=0,b=0;
    for (let yy=y; yy<y+ph; yy++) for (let xx=x; xx<x+pw; xx++) {
      tot++;
      if (xx<w && yy<h && alpha(xx,yy)>16) { n++; const c=rgb(xx,yy); r+=c[0]; g+=c[1]; b+=c[2]; }
    }
    parts.push(part+' fill='+(n/tot).toFixed(2)+' rgb='+(n?Math.round(r/n)+','+Math.round(g/n)+','+Math.round(b/n):'-'));
  }
  console.log(k.padEnd(9)+' | '+parts.join(' | '));
}
