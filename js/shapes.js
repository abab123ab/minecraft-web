import { BLOCKS, isSolid } from './blocks.js';

// 方块形状层。
//
// 以前「一个方块 = 一个满格立方体」是硬编码在 mesher / player / mobs / entities 里的：
// 谁要判断「这一格能不能站」就直接 isSolid(id)，谁要画方块就写死 0..1 的八个顶点。
// 床要变成原版的 2 格长 × 9/16 高，就必须先把「形状」单独抽成一层。
//
// 盒子项是 { box: [x0,y0,z0,x1,y1,z1], tile? }，单位是格（1 = 一整个方块），
// 原点在方块自己的最小角。一个方块可以有多个盒子（床 = 床垫体 + 两条腿）。不填 = 满格。
//
// 盒子上带 tile 就用那一张（六面通用）—— 床腿靠这个走木纹。不带的话整块都跟着
// 方块的 faceFor/faces/tiles 走，而 faceFor 是说「哪一面不建」的，套到腿上会让腿缺面。
//
// 方块可以声明这两样（见 blocks.js 的 def）：
//   boxes(meta)   外观盒子表
//   collide(meta) 判定箱。形状和碰撞可以分开 —— 原版床就是这样：判定箱是一个 9/16 高的
//                 整底盒子，腿只是外观模型、不参与碰撞。不填 = 跟外观一样。

export const FULL_BOX = [{ box: [0, 0, 0, 1, 1, 1] }];

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
  for (const item of blockBoxes(id, meta)) {
    const b = item.box;
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

// 世界坐标下的一个 AABB 跟 (bx,by,bz) 这一格的**判定箱**是否相交。
// b 是 {minX,maxX,minY,maxY,minZ,maxZ}。
//
// 为什么不能只问 isSolid：床只有 9/16 高，只问「这格是实心吗」的话，
// 走路时会被床前面那一层空气挡住（贴着床走不进去），站上去又会被床垫顶起来。
export function boxHitsBlock(b, bx, by, bz, id, meta) {
  const def = BLOCKS[id];
  // 没声明形状 = 满格，直接算撞上。绝大多数方块走这条，别为它们建数组。
  if (!def.boxes && !def.collide) return true;
  for (const item of blockCollide(id, meta)) {
    const s = item.box;
    if (b.maxX > bx + s[0] && b.minX < bx + s[3] &&
        b.maxY > by + s[1] && b.minY < by + s[4] &&
        b.maxZ > bz + s[2] && b.minZ < bz + s[5]) return true;
  }
  return false;
}

// 按点采样共用一个盒子对象，别在每帧的热路径里造垃圾。
const POINT_BOX = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

// 世界坐标点 (x,y,z) 是否落在某个实心方块的判定箱里。
// 生物和掉落物是按点采样的（没有体积盒），这里让它们也认形状 —— 否则它们会
// 直接穿过床那 9/16 的高度限制，踩在空气上走。
export function pointHitsSolid(world, x, y, z) {
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  const id = world.getBlock(bx, by, bz);
  if (!isSolid(id)) return false;
  POINT_BOX.minX = POINT_BOX.maxX = x;
  POINT_BOX.minY = POINT_BOX.maxY = y;
  POINT_BOX.minZ = POINT_BOX.maxZ = z;
  return boxHitsBlock(POINT_BOX, bx, by, bz, id, world.getMeta(bx, by, bz));
}
