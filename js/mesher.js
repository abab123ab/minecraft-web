import * as THREE from './vendor/three.module.js';
import { BLOCKS, AIR } from './blocks.js';
import { tileUV, TILE_INDEX } from './textures.js';
import { CHUNK, HEIGHT, SECTION } from './worlddef.js';
import { B } from './worldgen.js';
import { blockBoxes, isFullCube, FULL_BOX } from './shapes.js';

const FACES = [
  {
    key: 'px', dir: [1, 0, 0], tile: 1, shade: 0.72, uAxis: [0, 0, -1], vAxis: [0, 1, 0],
    verts: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    key: 'nx', dir: [-1, 0, 0], tile: 1, shade: 0.72, uAxis: [0, 0, 1], vAxis: [0, 1, 0],
    verts: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    key: 'py', dir: [0, 1, 0], tile: 0, shade: 1.0, uAxis: [1, 0, 0], vAxis: [0, 0, -1],
    verts: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    key: 'ny', dir: [0, -1, 0], tile: 2, shade: 0.50, uAxis: [1, 0, 0], vAxis: [0, 0, 1],
    verts: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    key: 'pz', dir: [0, 0, 1], tile: 1, shade: 0.88, uAxis: [1, 0, 0], vAxis: [0, 1, 0],
    verts: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    key: 'nz', dir: [0, 0, -1], tile: 1, shade: 0.88, uAxis: [-1, 0, 0], vAxis: [0, 1, 0],
    verts: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  }
];

const CORNER_SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function solidForAO(id) {
  return BLOCKS[id].opaque;
}

// 顶点该到贴图上采哪个 uv。r 是 90° 的圈数（0..3），方向跟 bedshape.js 的 bedRot
// 对齐：让贴图的「上」（v 增大）指向床头。
// 顶面基准是 u = x、v = 1-z，所以 L=+x → 3、L=+z → 2、L=-x → 1、L=-z → 0。
function rotUV(u, v, r) {
  if (r === 1) return [v, 1 - u];
  if (r === 2) return [1 - u, 1 - v];
  if (r === 3) return [1 - v, u];
  return [u, v];
}

export function buildSectionBatches(ch, si, ctx) {
  const grid = [];
  const skyGrid = [];
  const litGrid = [];
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const n = ctx.getChunk(ch.cx + i, ch.cz + j);
      grid.push(n ? n.data : null);
      skyGrid.push(n ? n.skyLight : null);
      litGrid.push(n ? n.blockLight : null);
    }
  }
  const pick = (arrs, x, y, z) => {
    if (y < 0 || y >= HEIGHT) return null;
    const ix = x < 0 ? 0 : (x > 15 ? 2 : 1);
    const iz = z < 0 ? 0 : (z > 15 ? 2 : 1);
    const arr = arrs[iz * 3 + ix];
    if (!arr) return null;
    return arr[(x - (ix - 1) * 16) + CHUNK * ((z - (iz - 1) * 16) + CHUNK * y)];
  };
  const get = (x, y, z) => {
    const v = pick(grid, x, y, z);
    return v === null ? AIR : v;
  };
  // 光照只存在于非通透方块里：computeSectionLight 不会往不透明方块内部写光，
  // 所以取光必须看「面外侧那一格」，也就是真正透光的空气/水/玻璃，而不是被建面的实心块自己。
  const skyAt = (x, y, z) => pick(skyGrid, x, y, z) || 0;
  const litAt = (x, y, z) => pick(litGrid, x, y, z) || 0;

  const opaque = { pos: [], uv: [], col: [], idx: [] };
  const cutout = { pos: [], uv: [], col: [], idx: [] };
  const water = { pos: [], uv: [], col: [], idx: [] };
  const glass = { pos: [], uv: [], col: [], idx: [] };

  const data = ch.data;
  const metaArr = ch.meta;

  const yStart = si * SECTION, yEnd = yStart + SECTION;

  for (let y = yStart; y < yEnd; y++) {
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const idx = x + CHUNK * (z + CHUNK * y);
        const id = data[idx];
        if (id === AIR) continue;
        const block = BLOCKS[id];
        const tiles = block.tiles;
        if (!tiles) continue;
        const meta = metaArr ? metaArr[idx] : 0;

        if (id === B.torch) {
          // 火把走镂空批次。它那张贴图 80% 是全透明像素（只有中间一条是木棍 + 火苗），
          // 以前挂在镂空批次出来之前，只能丢进不透明批次 —— 而那个批次不看 alpha，
          // 透明像素按自己的 rgb(0,0,0) 画出来，整根火把就是一根黑条。
          addTorchQuads(cutout, x, y, z, tiles);
          continue;
        }

        // 一个方块可以不止一个盒子（床 = 床垫体 + 两条腿），逐个建面。
        const boxes = blockBoxes(id, meta);
        // AO 的采样点是按「整格」算的，小盒子（床垫、床腿）用它会取到隔壁格的遮挡，
        // 跟它自己那点体积对不上 —— 所以只有满格方块收 AO。
        const useAO = ctx.useAO && boxes === FULL_BOX;
        const aboveAir = get(x, y + 1, z) === AIR;
        const waterTop = block.liquid && aboveAir ? 0.875 : 1;

        for (let bi = 0; bi < boxes.length; bi++) {
          const item = boxes[bi];
          const box = item.box;
          const bx0 = box[0], by0 = box[1], bz0 = box[2];
          const sx = box[3] - box[0], sy = box[4] - box[1], sz = box[5] - box[2];

          for (let f = 0; f < 6; f++) {
            const face = FACES[f];
            const ndx = x + face.dir[0], ndy = y + face.dir[1], ndz = z + face.dir[2];
            const nb = get(ndx, ndy, ndz);
            // 邻居得「整格实心」才挡得住这一面 —— 这里不能只看 opaque：床也是不透明的，
            // 但它只有 9/16 高，旁边的石头要是因为「邻居不透明」就整面不建，石头上半截会露出一个洞。
            // 同种方块贴在一起时中间那层也不建面（玻璃除外：玻璃块的边框必须一块一块画出来）。
            // 树叶算满格实心，所以这里天然走「不建面」这条 —— 一片树冠只有外壳有面。
            // 把树叶也放进这条例外里试过，树冠内部 6 面全建，镂空面数直接超过整个地形。
            if (isFullCube(nb) && !(nb === id && block.transparent)) continue;
            if (block.liquid) {
              if (nb === id) continue;
              if (face.dir[1] === -1) continue;
              if (face.dir[1] === 1 && nb !== AIR) continue;
            }

            const target = block.liquid ? water
              : (block.cutout ? cutout : (block.transparent ? glass : opaque));
            // 贴图：盒子自带的 tile（床腿）> faceFor（床垫按朝向和床头/床尾选图，
            // 返回 null 表示这一面根本不建）> faces（熔炉炉门那种按方向覆盖）> tiles（顶/侧/底）。
            // 注意 tiles[1] 同时是物品栏图标（items.js 取它），所以别去改 tiles。
            let tileName;
            if (item.tile) {
              tileName = item.tile;
            } else if (block.faceFor) {
              tileName = block.faceFor(meta, face.key);
              if (tileName === null) continue;
            } else {
              const override = block.faces ? block.faces[face.key] : null;
              tileName = override || tiles[face.tile];
            }
            const ti = TILE_INDEX[tileName];
            const uvR = tileUV(ti === undefined ? 0 : ti);
            const rot = block.rotFor ? block.rotFor(meta, face.key) : 0;

            const base = target.pos.length / 3;
            const ao = [0, 0, 0, 0];

            const skyL = skyAt(ndx, ndy, ndz);
            const litL = litAt(ndx, ndy, ndz);
            // 天光与方块光取较大者，不能相加：相加会让 lv 超过 1，
            // r/g 先被 min(1,...) 截断而 b 不会，火把区就会由暖色反转成冷色，同时整体双重计亮。
            let lv = Math.max(skyL, litL) / 15;
            if (lv < 0.30) lv = 0.30;
            const warm = Math.max(0, litL - skyL) / 15;
            const cr = Math.min(1, lv + warm * 0.18);
            const cg = Math.min(1, lv + warm * 0.06);
            const cb = Math.max(0, lv - warm * 0.06);

            for (let v = 0; v < 4; v++) {
              const vtx = face.verts[v];
              const sign = CORNER_SIGNS[v];
              // 盒子就是把单位立方体的顶点按盒子的范围缩放一下。vtx 只取 0 或 1，
              // 所以是纯线性插值 —— 满格盒子 [0,0,0,1,1,1] 算出来跟以前逐位相同。
              const px = x + bx0 + vtx[0] * sx;
              const py = y + by0 + vtx[1] * sy * waterTop;
              const pz = z + bz0 + vtx[2] * sz;

              let aoLevel = 3;
              if (useAO) {
                const s1 = solidForAO(get(
                  ndx + face.uAxis[0] * sign[0],
                  ndy + face.uAxis[1] * sign[0],
                  ndz + face.uAxis[2] * sign[0]
                )) ? 1 : 0;
                const s2 = solidForAO(get(
                  ndx + face.vAxis[0] * sign[1],
                  ndy + face.vAxis[1] * sign[1],
                  ndz + face.vAxis[2] * sign[1]
                )) ? 1 : 0;
                const cnr = solidForAO(get(
                  ndx + face.uAxis[0] * sign[0] + face.vAxis[0] * sign[1],
                  ndy + face.uAxis[1] * sign[0] + face.vAxis[1] * sign[1],
                  ndz + face.uAxis[2] * sign[0] + face.vAxis[2] * sign[1]
                )) ? 1 : 0;
                aoLevel = (s1 && s2) ? 0 : 3 - (s1 + s2 + cnr);
              }
              ao[v] = aoLevel;

              const aof = 0.55 + 0.15 * ao[v];
              const shade = face.shade * aof;
              const tuv = rotUV(face.uvs[v][0], face.uvs[v][1], rot);
              target.pos.push(px, py, pz);
              target.uv.push(
                uvR.u0 + (uvR.u1 - uvR.u0) * tuv[0],
                uvR.v0 + (uvR.v1 - uvR.v0) * tuv[1]
              );
              target.col.push(cr * shade, cg * shade, cb * shade);
            }

            if (ao[0] + ao[2] > ao[1] + ao[3]) {
              target.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            } else {
              target.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
            }
          }
        }
      }
    }
  }

  return { opaque, cutout, water, glass };
}

export function setSectionMesh(scene, ch, si, prop, buf, material, order) {
  const sec = ch.secs[si];
  const old = sec[prop];
  if (old) { scene.remove(old); old.geometry.dispose(); sec[prop] = null; }
  if (buf.idx.length === 0) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setIndex(buf.idx);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.position.set(ch.cx * CHUNK, 0, ch.cz * CHUNK);
  mesh.renderOrder = order;
  mesh.frustumCulled = true;
  sec[prop] = mesh;
  scene.add(mesh);
}

function addTorchQuads(target, x, y, z, tiles) {
  const ti = TILE_INDEX[tiles[1]];
  const uvR = tileUV(ti === undefined ? 0 : ti);
  // torch.png 的内容只占 x=6..9、y=1..15 这一小块（火焰 6 行 + 木棍 9 行），
  // 四周全是全透明像素。UV 要正好取这一块 —— 整张 16x16 铺上去的话，
  // 木棍只占 2/16，实宽 2/16*0.2 = 0.025 格，细成一根头发。
  // 下面这些是「贴图内的比例」，不是格数：u/v 的分母都是 16（一个贴图像素的宽度）。
  // v 方向朝上，贴图第 r 行占 v 的 [(15-r)/16, (16-r)/16]。
  const U0 = 6 / 16, U1 = 10 / 16;      // 横向：第 6~9 列
  const V0 = 0, V1 = 15 / 16;           // 纵向：第 1~15 行（v=0 是最底下那行）
  const FU0 = 6 / 16, FU1 = 10 / 16;    // 顶面只画火苗：第 1~6 行
  const FV0 = 9 / 16, FV1 = 15 / 16;
  const W = 0.20, H = 0.625;            // 木棍 = 内容宽的一半 = 0.10 格
  const x0 = x + 0.5 - W / 2, x1 = x + 0.5 + W / 2;
  const z0 = z + 0.5 - W / 2, z1 = z + 0.5 + W / 2;
  const yb = y, yt = y + H;
  const side = [[U0, V0], [U1, V0], [U1, V1], [U0, V1]];
  const top = [[FU0, FV0], [FU1, FV0], [FU1, FV1], [FU0, FV1]];
  const quads = [
    { pts: [[x1, yb, z1], [x1, yb, z0], [x1, yt, z0], [x1, yt, z1]], uv: side, shade: 0.7 },
    { pts: [[x0, yb, z0], [x0, yb, z1], [x0, yt, z1], [x0, yt, z0]], uv: side, shade: 0.7 },
    { pts: [[x0, yb, z1], [x1, yb, z1], [x1, yt, z1], [x0, yt, z1]], uv: side, shade: 0.88 },
    { pts: [[x1, yb, z0], [x0, yb, z0], [x0, yt, z0], [x1, yt, z0]], uv: side, shade: 0.88 },
    { pts: [[x0, yt, z0], [x1, yt, z0], [x1, yt, z1], [x0, yt, z1]], uv: top, shade: 1.0 }
  ];
  for (const q of quads) {
    const base = target.pos.length / 3;
    const sh = q.shade;
    for (let v = 0; v < 4; v++) {
      target.pos.push(q.pts[v][0], q.pts[v][1], q.pts[v][2]);
      target.uv.push(
        uvR.u0 + (uvR.u1 - uvR.u0) * q.uv[v][0],
        uvR.v0 + (uvR.v1 - uvR.v0) * q.uv[v][1]
      );
      target.col.push(sh, sh, sh);
    }
    target.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
