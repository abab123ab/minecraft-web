// 生成床的九张贴图。
//
// 几何在 js/bedshape.js：床垫体 16×16×6 悬在离地 3/16 处，所以**侧面纵向那 16 行
// 会被压进 6/16 格**（一行只占 0.375 像素）。因此侧面一律只用几条平色带
// （被子 / 床垫 / 木架），画细节压完就是一团糊。俯视图不受影响 —— 一格就是 16 像素，
// 可以照常画枕头、折痕。
//
// 贴图里 y=0 是「面的上方」（tileUV 的 v 朝上，图集第 0 行落在 v=1 那一侧）。
//
// 床尾格（foot）和床头格（head）各有一套长边和俯视 —— 床头那半多一块床头板。
//   bed_side / bed_side2                    床尾格长边 + 镜像
//   bed_side_head / bed_side_head2          床头格长边 + 镜像（靠床头那一端立着板）
//   bed_top                                 床尾格俯视
//   bed_top_head                            床头格俯视（床头板 + 枕头）
//   bed_head / bed_foot                     两端的端面
//   bed_bottom                              底面木纹
//
// 镜像那张不是多余的：px 面的 u 沿 -z 走、nx 面沿 +z，
// 同一张图铺两面会让床头板出现在物理上相反的两端。
//
// 长边图里**床头在右端（x=15 那一列）**：bedshape.js 的 bedFace 对「u 轴和床头方向
// 同向」的那一面用正图、反向的用镜像，所以正图的 +u 端就是床头那一侧。
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

// 侧面的三条平色带（被子 / 床垫 / 木架），纵向 16 行会被压成 6 像素，
// 所以每条都留了高光行和阴影行，压下去还能分得出层次。
function stripes(r, x0, x1) {
  r.rect(x0, 0, x1, 8, RED);
  r.rect(x0, 0, x1, 0, RED_HI);
  r.rect(x0, 8, x1, 8, RED_LO);
  r.rect(x0, 9, x1, 11, CREAM);
  r.rect(x0, 9, x1, 9, CREAM_HI);
  r.rect(x0, 11, x1, 11, CREAM_LO);
  r.rect(x0, 12, x1, 15, WOOD);
  r.rect(x0, 12, x1, 12, WOOD_HI);
  r.rect(x0, 15, x1, 15, WOOD_LO);
}

// 俯视图的公共部分：被子 + 两侧床沿
function topBase(r) {
  r.rect(0, 0, 15, 15, RED);
  r.rect(0, 0, 0, 15, WOOD);
  r.rect(0, 0, 0, 15, WOOD_HI);
  r.rect(15, 0, 15, 15, WOOD);
  r.rect(15, 0, 15, 15, WOOD_LO);
}

// ============ 1) 床尾格长边（床头方向在 +u，也就是图的右端） ============
const side = canvas();
stripes(side, 0, 15);
side.rect(14, 0, 15, 8, RED_LO);      // 朝床头那一端的被子边
write('bed_side', side.px);

// ============ 2) 上面那张的镜像 ============
const side2 = canvas();
side2.px.set(side.px);
side2.flipX();
write('bed_side2', side2.px);

// ============ 3) 床头格长边：右端立着床头板 ============
const sideHead = canvas();
stripes(sideHead, 0, 12);
sideHead.rect(13, 0, 15, 15, WOOD);
sideHead.rect(13, 0, 13, 15, WOOD_HI);
sideHead.rect(15, 0, 15, 15, WOOD_LO);
write('bed_side_head', sideHead.px);

// ============ 4) 上面那张的镜像 ============
const sideHead2 = canvas();
sideHead2.px.set(sideHead.px);
sideHead2.flipX();
write('bed_side_head2', sideHead2.px);

// ============ 5) 床尾格俯视：一整片被子 ============
const top = canvas();
topBase(top);
top.rect(1, 5, 14, 5, RED_HI);        // 被子上缘的褶
top.rect(1, 11, 14, 11, RED_LO);      // 折痕
write('bed_top', top.px);

// ============ 6) 床头格俯视：床头板 + 枕头 ============
// 俯视图的 v 朝 -z 走、旋转之后 v=1（图上边）就是床头方向，所以床头板画在 y=0 那行。
const topHead = canvas();
topBase(topHead);
topHead.rect(1, 0, 14, 0, WOOD);      // 床头板顶面
topHead.rect(1, 0, 14, 0, WOOD_HI);
topHead.rect(1, 1, 14, 4, WHITE);     // 枕头
topHead.rect(1, 1, 14, 1, WHITE_HI);
topHead.rect(1, 4, 14, 4, WHITE_LO);
topHead.rect(1, 5, 14, 5, RED_HI);
topHead.rect(1, 11, 14, 11, RED_LO);
write('bed_top_head', topHead.px);

// ============ 7) 床头端面：就是那块立着的床头板 ============
const head = canvas();
head.rect(0, 0, 15, 15, WOOD);
head.rect(0, 0, 15, 0, WOOD_HI);
head.rect(0, 1, 15, 1, WOOD_HI);
head.rect(0, 13, 15, 15, WOOD_LO);
write('bed_head', head.px);

// ============ 8) 床尾端面：被子的断面 ============
const foot = canvas();
stripes(foot, 0, 15);
write('bed_foot', foot.px);

// ============ 9) 底面木纹 ============
const bottom = canvas();
bottom.rect(0, 0, 15, 15, WOOD);
bottom.rect(0, 3, 15, 3, WOOD_LO);
bottom.rect(0, 8, 15, 8, WOOD_LO);
bottom.rect(0, 12, 15, 12, WOOD_LO);
bottom.rect(0, 0, 1, 15, WOOD_LO);
bottom.rect(14, 0, 15, 15, WOOD_LO);
write('bed_bottom', bottom.px);
