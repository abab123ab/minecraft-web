import fs from 'node:fs';
import path from 'node:path';
import { writePNG } from './pngenc.mjs';

const W = 16, H = 16;
const px = Buffer.alloc(W * H * 4);

function set(x, y, c, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a === undefined ? 255 : a;
}
function rect(x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const WOOD = hex('#6E4B2A'), WOOD_HI = hex('#8A6638'), WOOD_LO = hex('#4E3318');
const WHITE = hex('#EFEFEF'), WHITE_HI = hex('#FFFFFF'), WHITE_LO = hex('#CFCFCF');
const RED = hex('#C0392B'), RED_HI = hex('#E05A4A'), RED_LO = hex('#8E2A20');
const CREAM = hex('#E6D2A8'), CREAM_HI = hex('#F2E4C4'), CREAM_LO = hex('#C9B488');

// 床头板（左侧木栏）
rect(0, 0, 2, 10, WOOD);
rect(0, 0, 2, 0, WOOD_HI);
rect(0, 10, 2, 10, WOOD_LO);
rect(1, 1, 1, 9, WOOD_HI);

// 枕头（白）
rect(3, 3, 6, 8, WHITE);
rect(3, 3, 6, 3, WHITE_HI);
rect(6, 3, 6, 8, WHITE_LO);

// 被子（红）
rect(7, 3, 15, 8, RED);
rect(7, 3, 15, 3, RED_HI);
rect(7, 8, 15, 8, RED_LO);
rect(7, 6, 15, 6, RED_LO); // 折痕

// 床垫（奶油色，被子下方一行）
rect(3, 9, 15, 10, CREAM);
rect(3, 9, 15, 9, CREAM_HI);
rect(3, 10, 15, 10, CREAM_LO);

// 床架（底部木框 + 两腿）
rect(0, 11, 15, 15, WOOD);
rect(0, 11, 15, 11, WOOD_HI);
rect(0, 15, 15, 15, WOOD_LO);
rect(2, 12, 2, 15, WOOD_LO);
rect(13, 12, 13, 15, WOOD_LO);

const out = path.join(import.meta.dirname, '..', 'textures', 'block', 'bed.png');
writePNG(out, W, H, px);
console.log('写出 ' + out + '  ' + fs.statSync(out).size + ' bytes');
