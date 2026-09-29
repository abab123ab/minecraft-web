// 生成床的六张贴图。
//
// 以前只有一张 bed.png，六个面全用它 —— 于是四个侧面长得一模一样（每一面都在同一个
// 位置有床头板），分不出床头床尾；顶面也是这张侧视图。而且那张图顶部三行是镂空的
// （给「床垫上方的空间」留的），铺到立方体上就是三行洞。
//
// 现在按面拆开：
//   bed.png        长边（床头在左）
//   bed_side2.png  长边镜像 —— px 面的 u 是朝 -z 走的，nx 面朝 +z，
//                  同一张图铺两面会让床头板出现在相反的两端，所以 px 用镜像版
//   bed_head.png   床头那一端
//   bed_foot.png   床尾那一端
//   bed_top.png    俯视（枕头 + 被子 + 两侧床沿）
//   bed_bottom.png 底面木纹
//
// 贴图里 y=0 是「面的上方」（tileUV 里 v 朝上，图集第 0 行落在 v=1 那一侧）。
// 六张全部不透明 —— 立方体不需要留洞。
//
//   node tools/makebed.mjs
import fs from 'node:fs';
import path from 'node:path';
import { writePNG } from './pngenc.mjs';

const W = 16, H = 16;
const DIR = path.join(import.meta.dirname, '..', 'textures', 'block');

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const WOOD = hex('#6E4B2A'), WOOD_HI = hex('#8A6638'), WOOD_LO = hex('#4E3318');
const WHITE = hex('#EFEFEF'), WHITE_HI = hex('#FFFFFF'), WHITE_LO = hex('#CFCFCF');
const RED = hex('#C0392B'), RED_HI = hex('#E05A4A'), RED_LO = hex('#8E2A20');
const CREAM = hex('#E6D2A8'), CREAM_HI = hex('#F2E4C4'), CREAM_LO = hex('#C9B488');

function canvas() {
  const px = Buffer.alloc(W * H * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
  };
  // 水平镜像：px 和 nx 两面看到的 u 方向是反的
  const flipX = () => {
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const src = (y * W + x) * 4, dst = (y * W + (W - 1 - x)) * 4;
      px.copy(out, dst, src, src + 4);
    }
    px.set(out);
  };
  return { px, set, rect, flipX };
}

function write(name, px) {
  const out = path.join(DIR, name + '.png');
  writePNG(out, W, H, px);
  console.log('写出 textures/block/' + name + '.png  ' + fs.statSync(out).size + ' bytes');
}

// ---- 床架：底 5 行（含两条腿）+ 高光/阴影 ----
function frame(r) {
  r.rect(0, 11, 15, 15, WOOD);
  r.rect(0, 11, 15, 11, WOOD_HI);
  r.rect(0, 15, 15, 15, WOOD_LO);
}

// ---- 床垫：奶油色两行 ----
function mattress(r, x0, x1) {
  r.rect(x0, 9, x1, 10, CREAM);
  r.rect(x0, 9, x1, 9, CREAM_HI);
  r.rect(x0, 10, x1, 10, CREAM_LO);
}

// ============ 1) 长边（床头在左） ============
const side = canvas();
frame(side);
mattress(side, 2, 13);
side.rect(2, 0, 13, 8, RED);
side.rect(2, 0, 13, 0, RED_HI);
side.rect(2, 4, 13, 4, RED_LO);   // 折痕
side.rect(2, 8, 13, 8, RED_LO);   // 被子下缘
side.rect(2, 0, 5, 2, WHITE);     // 枕头（靠床头，露在被子上）
side.rect(2, 0, 5, 0, WHITE_HI);
side.rect(5, 0, 5, 2, WHITE_LO);
side.rect(0, 0, 1, 15, WOOD);     // 床头板
side.rect(0, 0, 0, 15, WOOD_HI);
side.rect(1, 0, 1, 15, WOOD_LO);
side.rect(14, 0, 15, 15, WOOD);   // 床尾挡板
side.rect(14, 0, 14, 15, WOOD_HI);
write('bed', side.px);

// ============ 2) 长边镜像（给 px 用） ============
const side2 = canvas();
side2.px.set(side.px);
side2.flipX();
write('bed_side2', side2.px);

// ============ 3) 床头端 ============
const head = canvas();
frame(head);
mattress(head, 0, 15);
head.rect(0, 2, 15, 9, WOOD);     // 床头板
head.rect(0, 2, 15, 2, WOOD_HI);
head.rect(0, 9, 15, 9, WOOD_LO);
head.rect(1, 0, 14, 1, WHITE);    // 枕头露在床头板上方
head.rect(1, 0, 14, 0, WHITE_HI);
head.rect(1, 1, 14, 1, WHITE_LO);
write('bed_head', head.px);

// ============ 4) 床尾端 ============
const foot = canvas();
frame(foot);
mattress(foot, 0, 15);
foot.rect(0, 0, 15, 8, RED);      // 被子断面（床尾只有被子）
foot.rect(0, 0, 15, 0, RED_HI);
foot.rect(0, 4, 15, 4, RED_LO);
foot.rect(0, 8, 15, 8, RED_LO);
write('bed_foot', foot.px);

// ============ 5) 俯视 ============
// 俯视图里 y=0 那一行是床头那一侧（py 面的 v 朝 -z 走），x 就是方块自己的 x。
const top = canvas();
top.rect(0, 0, 15, 15, RED);
top.rect(1, 0, 14, 0, WOOD);      // 床头板
top.rect(0, 1, 0, 15, WOOD);      // 两侧床沿
top.rect(15, 1, 15, 15, WOOD);
top.rect(1, 5, 14, 5, RED_HI);    // 被子上缘
top.rect(1, 10, 14, 10, RED_LO);  // 折痕
top.rect(2, 1, 13, 4, WHITE);     // 枕头
top.rect(2, 1, 13, 1, WHITE_HI);
top.rect(2, 4, 13, 4, WHITE_LO);
top.rect(0, 0, 1, 1, WOOD_LO);    // 四角立柱
top.rect(14, 0, 15, 1, WOOD_LO);
top.rect(0, 14, 1, 15, WOOD_LO);
top.rect(14, 14, 15, 15, WOOD_LO);
write('bed_top', top.px);

// ============ 6) 底面 ============
const bottom = canvas();
bottom.rect(0, 0, 15, 15, WOOD);
bottom.rect(0, 3, 15, 3, WOOD_LO);
bottom.rect(0, 8, 15, 8, WOOD_LO);
bottom.rect(0, 12, 15, 12, WOOD_LO);
bottom.rect(0, 0, 1, 15, WOOD_LO);
bottom.rect(14, 0, 15, 15, WOOD_LO);
write('bed_bottom', bottom.px);
