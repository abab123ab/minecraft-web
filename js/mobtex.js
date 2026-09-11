import * as THREE from './vendor/three.module.js';

const PART = {
  pig:      { head: [8, 8, 8, 8],   body: [28, 8, 16, 8],  leg: [4, 20, 4, 6],  peek: 8, gap: 2 },
  cow:      { head: [8, 8, 8, 8],   body: [4, 4, 12, 8],   leg: [4, 20, 4, 6],  peek: 8, gap: 2 },
  sheep:    { head: [8, 8, 8, 8],   body: [34, 16, 8, 14], leg: [4, 20, 4, 6],  peek: 2, gap: 2 },
  chicken:  { head: [4, 4, 4, 6],   body: [6, 15, 6, 8],   leg: [30, 15, 2, 5], peek: 1, gap: 2 },
  zombie:   { head: [8, 8, 8, 8],   body: [20, 20, 8, 12], leg: [4, 20, 4, 12], peek: 0, gap: 2 },
  skeleton: { head: [8, 8, 8, 8],   body: [20, 20, 8, 12], leg: [4, 20, 4, 10], peek: 0, gap: 2, legGap: -4 },
  creeper:  { head: [8, 8, 8, 8],   body: [20, 20, 8, 12], leg: [4, 20, 4, 6],  peek: 0, gap: 2 }
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

function blit(ctx, img, r, dx, dy) {
  ctx.drawImage(img, r[0], r[1], r[2], r[3], dx, dy, r[2], r[3]);
}

function compose(type, img) {
  const p = PART[type];
  const legW = p.leg[2];
  const legTotal = legW * 2 + p.gap;
  const bodyY = p.peek === 0 ? p.head[3] : p.peek;
  const legY = bodyY + p.body[3] - 1 + (p.legGap || 0);
  const w = Math.max(p.head[2], p.body[2], legTotal);
  const h = legY + p.leg[3];

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  blit(ctx, img, p.body, ((w - p.body[2]) / 2) | 0, bodyY);
  const lx = ((w - legTotal) / 2) | 0;
  blit(ctx, img, p.leg, lx, legY);
  blit(ctx, img, p.leg, lx + legW + p.gap, legY);
  blit(ctx, img, p.head, ((w - p.head[2]) / 2) | 0, 0);

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
