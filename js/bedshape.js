// 床的几何。原版的床是「两个方块长、一个方块宽、9/16 高」：
//
//   判定箱（原版 BlockBed.SHAPE）= [0,0,0]-[16,9,16]，也就是一个 9/16 高的整底盒子，
//     跟腿没关系。原版 wiki 的「判定箱」列表里床就写在 0.5625（9/16）那一行，
//     备注写的是「底面看着没东西，其实是实心的」—— 说的就是这个。
//   外观模型 = 床垫体 16x16x6 坐在 y=3..9，两个端头各两条 3x3x3 的腿（y=0..3）。
//     腿是模型，不是判定箱。
//
// 方块状态两个（原版同名）：
//   facing —— 床头指向哪，取值 north/south/east/west；也是放置时玩家的朝向。
//   part   —— foot（床尾）/ head（床头）。
// 这里压成一个字节：meta = part | (facing << 1)。
//
// 这个文件是纯几何 + 纯查表，不认识方块表，所以 tools/makebed.mjs 也能直接 import。
// 世界轴约定（跟 mesher 的 FACES 表一致）：+x 东、-x 西、+z 南、-z 北。

// 判定箱高度：9/16
export const BED_H = 9 / 16;
// 床垫体底面高度（= 腿高）：3/16
export const BED_BODY_Y0 = 3 / 16;
// 一条腿的边长：3/16
export const BED_LEG = 3 / 16;

// 床头指向的方向 [dx, dz]。下标 = facing，0=北(-z) 1=南(+z) 2=西(-x) 3=东(+x)
export const BED_FACING = [[0, -1], [0, 1], [-1, 0], [1, 0]];
export const BED_FACING_NAME = ['北(-z)', '南(+z)', '西(-x)', '东(+x)'];

export const bedFacing = (meta) => BED_FACING[(meta >> 1) & 3];
export const bedIsHead = (meta) => (meta & 1) === 1;
export const bedMeta = (facing, head) => ((facing & 3) << 1) | (head ? 1 : 0);

// 判定箱：一个整底盒子，9/16 高。跟腿无关。
export const BED_LEG_TILE = 'bed_bottom';

export function bedCollide() {
  return [{ box: [0, 0, 0, 1, BED_H, 1] }];
}

// 外观：床垫体 + 两条腿。
// 腿永远在「整张床的外端」—— 床头格的腿在 +facing 那一端，床尾格的腿在 -facing 那一端，
// 合起来就是整张床的四个角，中间那段床底是空的（原版两个模型文件各管自己那一头也是这个道理）。
//
// 注意「+facing 那一端」到底是轴上的大端还是小端，得看 facing 的轴分量是正是负：
// 床头朝北（-z）时，床头的腿在格内 z=0 那一侧；朝南（+z）时在 z=13/16 那一侧。
export function bedBoxes(meta) {
  const f = bedFacing(meta);
  const ax = f[0] !== 0 ? 0 : 2;          // 床轴落在哪根世界轴上：0=x，2=z
  const perp = ax === 0 ? 2 : 0;
  const fAxis = ax === 0 ? f[0] : f[1];
  const near1 = (bedIsHead(meta) ? fAxis : -fAxis) > 0;
  const a0 = near1 ? 1 - BED_LEG : 0;
  const a1 = near1 ? 1 : BED_LEG;
  const boxes = [{ box: [0, BED_BODY_Y0, 0, 1, BED_H, 1] }];
  for (const p of [0, 1 - BED_LEG]) {
    const b = [0, 0, 0, 1, BED_LEG, 1];
    b[ax] = a0; b[ax + 3] = a1;
    b[perp] = p; b[perp + 3] = p + BED_LEG;
    boxes.push({ box: b, tile: BED_LEG_TILE });
  }
  return boxes;
}

// 侧面四个方向各自的「法线」和「u 轴」，数值抄自 mesher.js 的 FACES 表（只取水平分量）。
const SIDE_N = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] };
const SIDE_U = { px: [0, -1], nx: [0, 1], pz: [1, 0], nz: [-1, 0] };

// 这一面用哪张贴图；返回 null 表示这一面根本不建。
//
// 端面：法线和床轴平行。朝床头那一侧只有「床头格」有面（床尾格的同侧贴着另一半，
// 原版也是直接把这一面跳掉；这里就算不跳也会被「邻居不透明」的剔除规则挡掉）。
// 长边：法线垂直于床轴，两张互为镜像的图按 u 方向和床头方向是否同向来选。
export function bedFace(meta, key) {
  if (key === 'py') return bedIsHead(meta) ? 'bed_top_head' : 'bed_top';
  if (key === 'ny') return 'bed_bottom';
  const f = bedFacing(meta);
  const n = SIDE_N[key];
  const along = n[0] * f[0] + n[1] * f[1];
  if (along > 0) return bedIsHead(meta) ? 'bed_head' : null;
  if (along < 0) return bedIsHead(meta) ? null : 'bed_foot';
  const u = SIDE_U[key];
  const same = u[0] * f[0] + u[1] * f[1] > 0;
  const base = bedIsHead(meta) ? 'bed_side_head' : 'bed_side';
  return same ? base : base + '2';
}

// 顶面要转多少度（0/90/180/270），让贴图的「+v = 朝床头、+u = 右手边」这套
// 局部坐标系对上世界。
//
// 推导（顶面基准 uv 是 u = x、v = 1-z）：想让 u_tex = R·p、v_tex = L·p，
// 其中 L = 床头方向、R = (-L.z, L.x)，代进去正好是四个纯旋转：
//   L=+x → 270°，L=+z → 180°，L=-x → 90°，L=-z → 0°
// 底面是整块木纹，转不转看不出来，一律 0。
export function bedRot(meta, key) {
  if (key !== 'py') return 0;
  const f = bedFacing(meta);
  if (f[0] === 1) return 3;
  if (f[1] === 1) return 2;
  if (f[0] === -1) return 1;
  return 0;
}

// 摆一张床：床尾放在选中的格子上，床头放在「远离玩家」的那一格（原版就是这个规则）。
// 玩家朝向在引擎里是 yaw，正前方 = (-sin yaw, -cos yaw)。取最接近的那根轴。
export function bedPlaceMeta(yaw) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let facing;
  if (Math.abs(fx) > Math.abs(fz)) facing = fx > 0 ? 3 : 2;
  else facing = fz > 0 ? 1 : 0;
  return { facing, foot: bedMeta(facing, false), head: bedMeta(facing, true), dx: BED_FACING[facing][0], dz: BED_FACING[facing][1] };
}
