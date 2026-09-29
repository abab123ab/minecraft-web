import { BLOCKS } from './blocks.js';

// 方块形状层。
//
// 以前「一个方块 = 一个满格立方体」是硬编码在 mesher / player / mobs / entities 里的：
// 谁要判断「这一格能不能站」就直接 isSolid(id)，谁要画方块就写死 0..1 的八个顶点。
// 床要变成原版的 2 格长 × 9/16 高，就必须先把「形状」单独抽成一层。
//
// 盒子格式：[x0, y0, z0, x1, y1, z1]，单位是格（1 = 一整个方块），原点在方块自己的最小角。
// 一个方块可以有多个盒子（床 = 床垫体 + 两条腿）。不填 = 满格。
//
// 方块可以声明这两样（见 blocks.js 的 def）：
//   boxes(meta)   外观盒子表
//   collide(meta) 判定箱。形状和碰撞可以分开 —— 原版床就是这样：判定箱是一个 9/16 高的
//                 整底盒子，腿只是外观模型、不参与碰撞。不填 = 跟外观一样。

export const FULL_BOX = [[0, 0, 0, 1, 1, 1]];

const boxCache = new Map();
const colCache = new Map();
const boundsCache = new Map();

// 同一个 (方块, meta) 每帧会被问很多次（碰撞、建面剔除都要问），算一次就存下来。
// meta 是一个字节，所以 id * 256 + meta 当键是唯一的。
function evalShape(b, field, cache, meta) {
  const v = b[field];
  if (v === null || v === undefined) return null;
  const key = (b.id << 8) | (meta & 255);
  let r = cache.get(key);
  if (r === undefined) {
    r = typeof v === 'function' ? v(meta & 255) : v;
    cache.set(key, r);
  }
  return r;
}

// 外观盒子表。没声明形状的方块返回满格。
export function blockBoxes(id, meta) {
  return evalShape(BLOCKS[id], 'boxes', boxCache, meta) || FULL_BOX;
}

// 判定箱。没单独声明就退到外观盒子表。
export function blockCollide(id, meta) {
  return evalShape(BLOCKS[id], 'collide', colCache, meta) || blockBoxes(id, meta);
}

// 外观的包围盒 [x0,y0,z0,x1,y1,z1]。选中框要框住「看得见的那一坨」，
// 所以跟外观走、不跟判定箱走（原版床两者刚好一样，但那是巧合）。
export function shapeBounds(id, meta) {
  const key = (id << 8) | (meta & 255);
  let r = boundsCache.get(key);
  if (r) return r;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const b of blockBoxes(id, meta)) {
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] < z0) z0 = b[2];
    if (b[3] > x1) x1 = b[3];
    if (b[4] > y1) y1 = b[4];
    if (b[5] > z1) z1 = b[5];
  }
  r = [x0, y0, z0, x1, y1, z1];
  boundsCache.set(key, r);
  return r;
}

// 是不是「整格实心」—— 六个方向都挡得住才算。
// 建面剔除必须问这个，不能问 opaque：床只有 9/16 高，它旁边的石头**不能**因为
// 「邻居不透明」就把整面跳掉 —— 那样石头上半截会露出一个洞。
export function isFullCube(id) {
  const b = BLOCKS[id];
  return !!b.opaque && !b.boxes;
}
