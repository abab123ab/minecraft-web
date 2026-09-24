import * as THREE from './vendor/three.module.js';

// 生物不是一张贴纸，是一堆长方体拼起来的 3D 模型。
//
// 每只生物 = 若干个「块」：头、身子、四条腿（四足），或者头、身子、两只胳膊、
// 两条腿（人形）。每个块是个长方体，六个面各自从皮肤图上裁出对应那一块贴上去。
// 整只按自己的朝向转，所以你绕到它侧面看到的是侧面、走到背后看到的是屁股。
//
// 坐标一律沿用 MC 的模型空间（单位：贴图像素，16px = 1 方块）：
//   x 向右为正、y 向下为正、z 朝前为负。
// 最后在 buildMobMesh 里整体翻一下（y 和 z 同时取反，是个干净的 180° 旋转，
// 不会把贴图镜像），再缩放到底座贴地、总高等于判定框高度。
//
// 每块的三个几何量：
//   pivot  旋转轴心（MC 的 setRotationPoint）。腿就是绕这里前后摆的。
//   box    相对轴心的方框（MC 的 addBox：x/y/z 是起点，w/h/d 是三条棱长）。
//   tex    这块贴在皮肤图上的展开原点 (u,v) 和三条棱长。
//   rotX   绕 x 轴先转一下（MC 给四足动物的身子加的 π/2 ——
//          身子在贴图里是竖着的长条，转过来才是横躺的）。
//
// 带 parent 的块挂在父块上（猪鼻子跟头走、鸡嘴跟头走）。
// anim 标记会动的块：同名的用同一相位，legA/legB 反相（对角腿一起迈）。

const HALF = Math.PI / 2;
// 僵尸/骷髅的胳膊不是垂着的，是往前平举的（ModelZombie 里 f2 = -π/2.25）
const ARM_OUT = -Math.PI / 2.25;
// 四足动物的腿：轴心的 y 是 24-height（height 是腿长），前腿 z=-5、后腿 z=+7。
// 四条腿按对角线分成两组反相摆（leg1+leg4 一组、leg2+leg3 一组）。
function quadLegs(height, w) {
  const y = 24 - height;
  const tex = [0, 16, 4, height, 4];
  const box = [-2, 0, -2, 4, height, 4];
  return [
    { name: 'leg', tex, box, pivot: [-w, y, 7], anim: 'legA' },
    { name: 'leg', tex, box, pivot: [w, y, 7], anim: 'legB' },
    { name: 'leg', tex, box, pivot: [-w, y, -5], anim: 'legB' },
    { name: 'leg', tex, box, pivot: [w, y, -5], anim: 'legA' }
  ];
}

// 各面在贴图里的排布（相对这块的 u,v），以及「贴图向右 / 向下」分别对应
// 模型空间的哪个轴、哪个方向。推导依据：这块图是「从外面看」画的 ——
// 比如 right 面是站在生物右侧看到的，那时画面右边指向生物的正面（-z）。
// bright 是固定明暗（我们的引擎没有实体光照模型，靠这个把立体感做出来）：
// 顶面最亮、底面最暗，侧面居中。
const FACES = [
  { key: 'px', rect: (w, h, d) => [0, d, d, h], uAxis: 2, uSign: -1, vAxis: 1, vSign: 1, bright: 0.78 },
  { key: 'nx', rect: (w, h, d) => [d + w, d, d, h], uAxis: 2, uSign: 1, vAxis: 1, vSign: 1, bright: 0.78 },
  { key: 'py', rect: (w, h, d) => [d, 0, w, d], uAxis: 0, uSign: 1, vAxis: 2, vSign: 1, bright: 1.0 },
  { key: 'ny', rect: (w, h, d) => [d + w, 0, w, d], uAxis: 0, uSign: 1, vAxis: 2, vSign: -1, bright: 0.62 },
  { key: 'nz', rect: (w, h, d) => [d, d, w, h], uAxis: 0, uSign: -1, vAxis: 1, vSign: 1, bright: 0.92 },
  { key: 'pz', rect: (w, h, d) => [d + w + d, d, w, h], uAxis: 0, uSign: 1, vAxis: 1, vSign: 1, bright: 0.92 }
];

// 这个面在哪个轴上、固定在哪：
// px → x 固定在上界，nx → x 固定在下界，以此类推。
const FIXED = {
  px: [0, 1], nx: [0, 0], py: [1, 0], ny: [1, 1], nz: [2, 0], pz: [2, 1]
};

export const MODEL = {
  // 猪：ModelQuadruped(6) 出头/身/四条腿，ModelPig 把鼻子加在头上
  pig: {
    parts: [
      { name: 'body', tex: [28, 8, 10, 16, 8], box: [-5, -10, -7, 10, 16, 8], pivot: [0, 11, 2], rotX: HALF },
      { name: 'head', tex: [0, 0, 8, 8, 8], box: [-4, -4, -8, 8, 8, 8], pivot: [0, 12, -6] },
      { name: 'snout', tex: [16, 16, 4, 3, 1], box: [-2, 0, -9, 4, 3, 1], pivot: [0, 0, 0], parent: 'head' },
      ...quadLegs(6, 3)
    ]
  },
  // 牛：ModelCow（身子比通用的更宽、还带乳房；头在最前、带两只角；腿更靠外、前腿更靠前）
  cow: {
    parts: [
      { name: 'body', tex: [18, 4, 12, 18, 10], box: [-6, -10, -7, 12, 18, 10], pivot: [0, 5, 2], rotX: HALF },
      { name: 'udder', tex: [52, 0, 4, 6, 1], box: [-2, 2, -8, 4, 6, 1], pivot: [0, 5, 2], rotX: HALF },
      { name: 'head', tex: [0, 0, 8, 8, 6], box: [-4, -4, -6, 8, 8, 6], pivot: [0, 4, -8] },
      { name: 'horn', tex: [22, 0, 1, 3, 1], box: [-5, -5, -4, 1, 3, 1], pivot: [0, 0, 0], parent: 'head' },
      { name: 'horn', tex: [22, 0, 1, 3, 1], box: [4, -5, -4, 1, 3, 1], pivot: [0, 0, 0], parent: 'head' },
      { name: 'leg', tex: [0, 16, 4, 12, 4], box: [-2, 0, -2, 4, 12, 4], pivot: [-4, 12, 7], anim: 'legA' },
      { name: 'leg', tex: [0, 16, 4, 12, 4], box: [-2, 0, -2, 4, 12, 4], pivot: [4, 12, 7], anim: 'legB' },
      { name: 'leg', tex: [0, 16, 4, 12, 4], box: [-2, 0, -2, 4, 12, 4], pivot: [-4, 12, -6], anim: 'legB' },
      { name: 'leg', tex: [0, 16, 4, 12, 4], box: [-2, 0, -2, 4, 12, 4], pivot: [4, 12, -6], anim: 'legA' }
    ]
  },
  // 羊：SheepModel（身子 8x16x6 是羊毛那层，头 6x6x8 挂得比身子高）
  sheep: {
    parts: [
      { name: 'body', tex: [28, 8, 8, 16, 6], box: [-4, -10, -7, 8, 16, 6], pivot: [0, 5, 2], rotX: HALF },
      { name: 'head', tex: [0, 0, 6, 6, 8], box: [-3, -4, -6, 6, 6, 8], pivot: [0, 6, -8] },
      ...quadLegs(12, 3)
    ]
  },
  // 鸡：ModelChicken（头 4x6x3 + 嘴 + 肉垂、身 6x8x6、两片翅膀、两条腿）
  // 身子和四足动物一样要转 90°（MC 在 setRotationAngles 里给它 body.xRot = π/2）。
  // 这张 chicken.png 的腿那一块（26,0）几乎全透明，贴上去等于没有腿，
  // 所以腿用贴图上鸡嘴的橙色描成纯色块 —— 原版的鸡腿本来也就是一坨橙黄色。
  chicken: {
    legColor: 0xe8a33d,
    parts: [
      { name: 'body', tex: [0, 9, 6, 8, 6], box: [-3, -4, -3, 6, 8, 6], pivot: [0, 16, 0], rotX: HALF },
      { name: 'head', tex: [0, 0, 4, 6, 3], box: [-2, -6, -2, 4, 6, 3], pivot: [0, 15, -4] },
      { name: 'beak', tex: [14, 0, 4, 2, 2], box: [-2, -4, -4, 4, 2, 2], pivot: [0, 0, 0], parent: 'head' },
      { name: 'wattle', tex: [14, 4, 2, 2, 2], box: [-1, -2, -3, 2, 2, 2], pivot: [0, 0, 0], parent: 'head' },
      { name: 'wing', tex: [24, 13, 1, 4, 6], box: [0, 0, -3, 1, 4, 6], pivot: [-4, 13, 0] },
      { name: 'wing', tex: [24, 13, 1, 4, 6], box: [-1, 0, -3, 1, 4, 6], pivot: [4, 13, 0], mirror: true },
      { name: 'leg', box: [-1, 0, -3, 3, 5, 3], pivot: [-2, 19, 1], anim: 'legA', solid: true },
      { name: 'leg', box: [-1, 0, -3, 3, 5, 3], pivot: [1, 19, 1], anim: 'legB', solid: true }
    ]
  },
  // 僵尸：ModelZombie（人形。头 8x8x8、身 8x12x4、胳膊腿各 4x12x4；胳膊往前平举）
  zombie: {
    parts: [
      { name: 'body', tex: [16, 16, 8, 12, 4], box: [-4, 0, -2, 8, 12, 4], pivot: [0, 0, 0] },
      { name: 'head', tex: [0, 0, 8, 8, 8], box: [-4, -8, -4, 8, 8, 8], pivot: [0, 0, 0] },
      { name: 'arm', tex: [40, 16, 4, 12, 4], box: [-3, -2, -2, 4, 12, 4], pivot: [-5, 2, 0], rotX: ARM_OUT, anim: 'armA' },
      { name: 'arm', tex: [40, 16, 4, 12, 4], box: [-1, -2, -2, 4, 12, 4], pivot: [5, 2, 0], rotX: ARM_OUT, anim: 'armB', mirror: true },
      { name: 'leg', tex: [0, 16, 4, 12, 4], box: [-2, 0, -2, 4, 12, 4], pivot: [-2, 12, 0], anim: 'legB' },
      { name: 'leg', tex: [0, 16, 4, 12, 4], box: [-2, 0, -2, 4, 12, 4], pivot: [2, 12, 0], anim: 'legA', mirror: true }
    ]
  },
  // 骷髅：ModelSkeleton（人形，但胳膊腿都细一号：2x12x2；胳膊在 ±5 上）
  skeleton: {
    parts: [
      { name: 'body', tex: [16, 16, 8, 12, 4], box: [-4, 0, -2, 8, 12, 4], pivot: [0, 0, 0] },
      { name: 'head', tex: [0, 0, 8, 8, 8], box: [-4, -8, -4, 8, 8, 8], pivot: [0, 0, 0] },
      { name: 'arm', tex: [40, 16, 2, 12, 2], box: [-1, -2, -1, 2, 12, 2], pivot: [-5, 2, 0], rotX: ARM_OUT, anim: 'armA' },
      { name: 'arm', tex: [40, 16, 2, 12, 2], box: [-1, -2, -1, 2, 12, 2], pivot: [5, 2, 0], rotX: ARM_OUT, anim: 'armB', mirror: true },
      { name: 'leg', tex: [0, 16, 2, 12, 2], box: [-1, 0, -1, 2, 12, 2], pivot: [-2, 12, 0], anim: 'legB' },
      { name: 'leg', tex: [0, 16, 2, 12, 2], box: [-1, 0, -1, 2, 12, 2], pivot: [2, 12, 0], anim: 'legA', mirror: true }
    ]
  },
  // 苦力怕：ModelCreeper（头 8x8x8、身 8x12x4、四条腿贴在外侧）
  creeper: {
    parts: [
      { name: 'body', tex: [16, 16, 8, 12, 4], box: [-4, 0, -2, 8, 12, 4], pivot: [0, 6, 0] },
      { name: 'head', tex: [0, 0, 8, 8, 8], box: [-4, -8, -4, 8, 8, 8], pivot: [0, 6, 0] },
      { name: 'leg', tex: [0, 16, 4, 6, 4], box: [-2, 0, -2, 4, 6, 4], pivot: [-2, 18, -4], anim: 'legA' },
      { name: 'leg', tex: [0, 16, 4, 6, 4], box: [-2, 0, -2, 4, 6, 4], pivot: [2, 18, -4], anim: 'legB' },
      { name: 'leg', tex: [0, 16, 4, 6, 4], box: [-2, 0, -2, 4, 6, 4], pivot: [-2, 18, 4], anim: 'legB' },
      { name: 'leg', tex: [0, 16, 4, 6, 4], box: [-2, 0, -2, 4, 6, 4], pivot: [2, 18, 4], anim: 'legA' }
    ]
  }
};

export const MOB_KEYS = Object.keys(MODEL);

// ---------- 贴图 ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('贴图加载失败: ' + src));
    img.src = src;
  });
}

// 每只生物一张贴图。3D 模型直接从这张图上按面裁，不用再拼立绘了。
export const mobArt = {};

export async function buildMobArt() {
  await Promise.all(MOB_KEYS.map(async (t) => {
    const img = await loadImage('textures/entity/' + t + '.png');
    const tex = new THREE.Texture(img);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    mobArt[t] = { tex, texW: img.width, texH: img.height };
  }));
}

// ---------- 几何 ----------

// 一个长方体的六个面。box 是相对轴心的 MC 方框 [x,y,z,w,h,d]，
// tex 是这块在贴图上的展开原点与三条棱长 [u,v,w,h,d]，imgW/imgH 是贴图尺寸。
export function buildCube(box, tex, imgW, imgH, mirror) {
  const [bx, by, bz, w, h, d] = box;
  const [u, v, tw, th, td] = tex;
  const base = [bx, by, bz];
  const size = [w, h, d];

  const pos = [], uvs = [], col = [], idx = [];
  // 每个面 4 个顶点、6 个索引，所以顶点基址不能拿 idx.length 当（差了 1.5 倍）
  let vbase = 0;
  for (const face of FACES) {
    const [ru, rv, rw, rh] = face.rect(tw, th, td);
    // 一个面上四个角：贴图坐标 (0,0) 是左上角，对应顺序 左上→右上→右下→左下
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const [u01raw, v01] of corners) {
      const u01 = mirror ? 1 - u01raw : u01raw;
      const p = [0, 0, 0];
      const fixed = FIXED[face.key];
      p[fixed[0]] = fixed[1] ? base[fixed[0]] + size[fixed[0]] : base[fixed[0]];
      p[face.uAxis] = base[face.uAxis] + (face.uSign > 0 ? u01 * size[face.uAxis] : (1 - u01) * size[face.uAxis]);
      p[face.vAxis] = base[face.vAxis] + (face.vSign > 0 ? v01 * size[face.vAxis] : (1 - v01) * size[face.vAxis]);
      pos.push(p[0], p[1], p[2]);
      // 贴图 v 轴朝下、three 的 uv v 轴朝上，所以翻一下
      uvs.push((u + ru + u01 * rw) / imgW, 1 - (v + rv + v01 * rh) / imgH);
      col.push(face.bright, face.bright, face.bright);
    }
    idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    vbase += 4;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// 每块轴心在模型空间里的绝对位置。挂在父块上的块（猪鼻子、牛角、鸡嘴）
// 坐标是相对父块轴心写的，要顺着 parent 一层层加起来。
function partOffsets(parts) {
  const byName = {};
  return parts.map((part) => {
    const up = part.parent ? byName[part.parent] : null;
    const off = up
      ? [up[0] + part.pivot[0], up[1] + part.pivot[1], up[2] + part.pivot[2]]
      : [part.pivot[0], part.pivot[1], part.pivot[2]];
    byName[part.name] = off;
    return off;
  });
}

// 一块的方框在模型空间里的八个角（要算整只的包围盒用）
function boxCorners(box, pivot, rotX) {
  const [bx, by, bz, w, h, d] = box;
  const out = [];
  for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) {
    let p = [bx + i * w, by + j * h, bz + k * d];
    if (rotX) {
      const c = Math.cos(rotX), s = Math.sin(rotX);
      p = [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
    }
    out.push([p[0] + pivot[0], p[1] + pivot[1], p[2] + pivot[2]]);
  }
  return out;
}

// 造一只生物的网格。返回一个 Group：
//   group               —— 位置 / 朝向(yaw) / 游戏用的缩放，外面直接摆这个
//   group.userData.base —— 内层负责「底座贴地 + 归一高度 + 翻转」的那层
//   group.userData.parts—— 每个可动块的 Group，按 anim 名字索引
export function buildMobMesh(type, def) {
  const model = MODEL[type];
  const art = mobArt[type];
  if (!model || !art) return null;

  // 先量出整只在模型空间里的包围盒，才能把底座挪到 y=0、把高度归一
  const offs = partOffsets(model.parts);
  let minY = Infinity, maxY = -Infinity;
  model.parts.forEach((part, i) => {
    for (const p of boxCorners(part.box, offs[i], part.rotX)) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  });
  const span = maxY - minY;               // 模型空间里的总高（px）
  const k = def.h / span;                 // 让它渲染出来正好是判定框那么高

  const group = new THREE.Group();
  const base = new THREE.Group();
  base.scale.setScalar(k);
  base.rotation.x = Math.PI;              // y 和 z 一起取反：翻成 y 朝上、正面朝 +z
  base.position.y = maxY * k;             // 最低点落到 y=0
  group.add(base);

  const texMat = new THREE.MeshBasicMaterial({
    map: art.tex,
    transparent: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    vertexColors: true
  });
  const solidMat = model.legColor === undefined ? null : new THREE.MeshBasicMaterial({
    color: model.legColor,
    transparent: true,
    side: THREE.DoubleSide,
    vertexColors: true
  });
  const mats = solidMat ? [texMat, solidMat] : [texMat];

  const byName = {};
  const byAnim = {};
  const parts = [];
  for (const part of model.parts) {
    const pg = new THREE.Group();
    pg.position.set(part.pivot[0], part.pivot[1], part.pivot[2]);
    if (part.rotX) pg.rotation.x = part.rotX;
    const geo = part.solid
      ? buildCube(part.box, [0, 0, 1, 1, 1], 1, 1, false)
      : buildCube(part.box, part.tex, art.texW, art.texH, part.mirror);
    const pm = new THREE.Mesh(geo, part.solid ? solidMat : texMat);
    pm.name = part.name;
    pg.add(pm);
    (part.parent ? byName[part.parent] : base).add(pg);
    byName[part.name] = pg;
    if (part.anim) {
      if (!byAnim[part.anim]) byAnim[part.anim] = [];
      byAnim[part.anim].push(pg);
      // 摆腿的基准姿势是「竖直下垂」，记下来后面按相位加减
      pg.userData.restX = part.rotX || 0;
    }
    parts.push({ name: part.name, anim: part.anim, group: pg });
  }

  group.userData.base = base;
  group.userData.legs = byAnim.legA || [];
  group.userData.legsB = byAnim.legB || [];
  group.userData.arms = byAnim.armA || [];
  group.userData.armsB = byAnim.armB || [];
  group.userData.mats = mats;
  group.userData.modelHeight = def.h;
  return group;
}
