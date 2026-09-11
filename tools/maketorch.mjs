import fs from 'node:fs';
import path from 'node:path';
import { writePNG } from './pngenc.mjs';

const W = 16, H = 16;
const px = Buffer.alloc(W * H * 4);

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a === undefined ? 255 : a;
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

const CORE_HOT = hex('#FFFBC8');
const FLAME_HI = hex('#FFE97A');
const FLAME_MID = hex('#FFC63C');
const FLAME_LO = hex('#FF9412');
const EMBER = hex('#E8620C');
const WOOD_HI = hex('#A98554');
const WOOD_MID = hex('#8A6A45');
const WOOD_LO = hex('#6B5133');
const CHAR = hex('#4A3620');

function rect(x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c[0], c[1], c[2]);
}

// 火焰：y=1..5
set(8, 1, ...CORE_HOT);
set(7, 2, ...FLAME_HI); set(8, 2, ...CORE_HOT);
set(6, 3, ...FLAME_LO); set(7, 3, ...FLAME_HI); set(8, 3, ...FLAME_MID); set(9, 3, ...FLAME_LO);
set(6, 4, ...EMBER); set(7, 4, ...FLAME_MID); set(8, 4, ...FLAME_MID); set(9, 4, ...EMBER);
set(7, 5, ...FLAME_LO); set(8, 5, ...EMBER);

// 火把头（烧焦的木顶）：y=6
rect(6, 6, 9, 6, CHAR);
set(7, 6, ...EMBER); set(8, 6, ...FLAME_LO);

// 木棍：y=7..14，左亮右暗
for (let y = 7; y <= 14; y++) {
  set(7, y, ...WOOD_HI);
  set(8, y, ...WOOD_MID);
}
// 木棍底部收口
set(7, 15, ...WOOD_MID); set(8, 15, ...WOOD_LO);

// 两侧极淡描边，避免看起来是纯色条
for (let y = 7; y <= 14; y++) {
  set(6, y, ...WOOD_LO, 90);
  set(9, y, ...CHAR, 70);
}

const out = path.join(import.meta.dirname, '..', 'textures', 'block', 'torch.png');
writePNG(out, W, H, px);
console.log('写出 ' + out + '  ' + fs.statSync(out).size + ' bytes');
