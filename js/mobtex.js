import * as THREE from './vendor/three.module.js';

// 每种生物的立绘从贴图里裁三块拼出来：头、身子、腿。
//
// 裁剪框必须整个落在「一块真实面板」里。这七张贴图是 64x32 的皮肤图，
// 面板之间夹着透明的缝，框要是骑到缝上，那条缝就会被一起裁进立绘 ——
// 立绘再被 alphaTest 一抠，生物身上就出现竖着的破洞（猪的肚子、
// 鸡的脸都中过这个招）。改这里的数字之前先确认框里没有透明像素。
//
// 骨架的胸腔是骨头之间留空的，那是贴图本身画成这样；这种「框内的洞」
// 由 compose() 逐行补色填掉，所以骨架也需要框住正确的面板。
export const PART = {
  pig:      { head: [8, 8, 8, 8],  body: [36, 8, 16, 8], leg: [4, 20, 4, 6],  peek: 8, gap: 2 },
  cow:      { head: [8, 8, 8, 6],  body: [6, 4, 10, 8],  leg: [4, 20, 4, 6],  peek: 6, gap: 2 },
  sheep:    { head: [8, 8, 8, 6],  body: [34, 16, 8, 14], leg: [4, 20, 4, 6], peek: 2, gap: 2 },
  chicken:  { head: [3, 3, 6, 4],  body: [6, 15, 6, 8],  leg: [30, 15, 2, 5], peek: 1, gap: 2 },
  zombie:   { head: [8, 8, 8, 8],  body: [20, 20, 8, 12], leg: [4, 20, 4, 12], peek: 0, gap: 2 },
  skeleton: { head: [8, 8, 8, 8],  body: [20, 20, 8, 12], leg: [4, 20, 4, 10], peek: 0, gap: 2, legGap: -4 },
  creeper:  { head: [8, 8, 8, 8],  body: [20, 20, 8, 12], leg: [4, 20, 4, 6],  peek: 0, gap: 2 }
};

const TYPES = Object.keys(PART);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('贴图加载失败: ' + src));
    img.src = src;
  });
}

// 把一个裁剪框里的像素贴到目标缓冲上，顺手把框里的透明洞补掉。
//
// 为什么必须补：立绘会被当成带 alphaTest 的贴图来画，透明像素等于被抠掉。
// 骨架的胸腔本来就是「骨头之间留空」画的，直接铺上去的话胸口是一片窟窿，
// 能透过身子看见后面的草地。补的办法是逐行取该行不透明像素的平均色 ——
// 洞被填平了，但同一行里的横向明暗还在，所以看上去还是一副肋骨架。
function putPart(buf, ow, oh, px, rect, dx, dy) {
  const rw = rect[2], rh = rect[3];
  const part = new Array(rw * rh);
  let ar = 0, ag = 0, ab = 0, an = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const p = px(rect[0] + x, rect[1] + y);
      part[y * rw + x] = p;
      if (p[3] > 16) { ar += p[0]; ag += p[1]; ab += p[2]; an++; }
    }
  }
  if (!an) return;
  const whole = [Math.round(ar / an), Math.round(ag / an), Math.round(ab / an)];

  for (let y = 0; y < rh; y++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let x = 0; x < rw; x++) {
      const p = part[y * rw + x];
      if (p[3] > 16) { r += p[0]; g += p[1]; b += p[2]; n++; }
    }
    const fr = n ? Math.round(r / n) : whole[0];
    const fg = n ? Math.round(g / n) : whole[1];
    const fb = n ? Math.round(b / n) : whole[2];
    for (let x = 0; x < rw; x++) {
      if (part[y * rw + x][3] > 16) continue;
      part[y * rw + x] = [fr, fg, fb, 255];
    }
  }

  for (let y = 0; y < rh; y++) {
    const gy = dy + y;
    if (gy < 0 || gy >= oh) continue;
    for (let x = 0; x < rw; x++) {
      const gx = dx + x;
      if (gx < 0 || gx >= ow) continue;
      const p = part[y * rw + x];
      const o = (gy * ow + gx) * 4;
      buf[o] = p[0]; buf[o + 1] = p[1]; buf[o + 2] = p[2]; buf[o + 3] = 255;
    }
  }
}

export function compose(type, source) {
  const p = PART[type];
  const legW = p.leg[2];
  const legTotal = legW * 2 + p.gap;
  const bodyY = p.peek === 0 ? p.head[3] : p.peek;
  const legY = bodyY + p.body[3] - 1 + (p.legGap || 0);
  const w = Math.max(p.head[2], p.body[2], legTotal);
  const h = legY + p.leg[3];

  // 一次性把整张皮肤图读成像素数组，避免逐像素往画布上问
  const sw = source.width, sh = source.height;
  const tmp = document.createElement('canvas');
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(source, 0, 0);
  const data = tctx.getImageData(0, 0, sw, sh).data;
  const px = (x, y) => {
    const i = (y * sw + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };

  const buf = new Uint8ClampedArray(w * h * 4);
  putPart(buf, w, h, px, p.body, ((w - p.body[2]) / 2) | 0, bodyY);
  const lx = ((w - legTotal) / 2) | 0;
  putPart(buf, w, h, px, p.leg, lx, legY);
  putPart(buf, w, h, px, p.leg, lx + legW + p.gap, legY);
  putPart(buf, w, h, px, p.head, ((w - p.head[2]) / 2) | 0, 0);

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(buf, w, h), 0, 0);
  return c;
}

export const mobArt = {};

export async function buildMobArt() {
  await Promise.all(TYPES.map(async (t) => {
    const img = await loadImage('textures/entity/' + t + '.png');
    const canvas = compose(t, img);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    mobArt[t] = { tex, ratio: canvas.width / canvas.height, h: canvas.height / 16 };
  }));
}
