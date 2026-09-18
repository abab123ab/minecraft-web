import { fbm2, ridged2, perlin3, hash2 } from './noise.js';
import { BLOCKS, AIR } from './blocks.js';
import { CHUNK, HEIGHT, SEA } from './worlddef.js';

// 矿石密度总开关：所有矿的 veins 都乘这个数。想让矿更多/更少，只改这一个值。
// 1.0 是标定后的基准（总矿化率 ≈ 12% 的石头），改动后用 tools/oredist.mjs 复核。
const ORE_DENSITY = 1.0;
// 基岩逐层概率：y=0 必须 1.0，否则玩家会挖穿世界底掉出去。y=1..4 递减成齿状。
const BEDROCK_CHANCE = [1, 0.72, 0.48, 0.22, 0.06];

export const B = {};
function bid(key) { return BLOCKS.findIndex((b) => b.key === key); }
[
  'stone', 'grass', 'dirt', 'cobblestone', 'planks', 'log', 'leaves', 'sand', 'sandstone',
  'spruce_log', 'spruce_leaves',
  'gravel', 'snow_block', 'ice', 'glass', 'crafting_table', 'furnace', 'coal_ore', 'iron_ore',
  'gold_ore', 'diamond_ore', 'copper_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore',
  'obsidian', 'bedrock', 'water', 'wool', 'torch'
].forEach((k) => { B[k] = bid(k); });

// 矿石层带表。三个 y 值定义「三角形分布」：minY 和 maxY 处密度为 0、peakY 处最高。
// 单调斜坡（越深越多）是错的：煤应该最浅最普遍，钻石才对深度敏感。
//   veins = 每个区块平均撒几个锚点（可以是小数，7.5 表示有一半区块多长一条）
//   size  = 单条脉最多几格，硬上限——这是「不会长出上百格巨型矿脉」的保证
// 顺序有讲究：稀有的排前面，先占位置，免得钻石/绿宝石的格子被煤抢走。
// 表里的 veins 是按「总矿化率 ≈ 12% 的石头」标定过的，改动后用 tools/oredist.mjs 复核。
export const ORE_TABLE = [
  { seed: 81, block: B.emerald_ore,  minY: 40, peakY: 58, maxY: 74, veins: 18,   size: 4,  biome: 'mountains' },
  { seed: 44, block: B.diamond_ore,  minY: 1,  peakY: 3,  maxY: 14, veins: 2.8,  size: 8 },
  { seed: 71, block: B.lapis_ore,    minY: 1,  peakY: 7,  maxY: 22, veins: 3.6,  size: 8 },
  { seed: 61, block: B.redstone_ore, minY: 1,  peakY: 4,  maxY: 16, veins: 7.2,  size: 9 },
  { seed: 33, block: B.gold_ore,     minY: 1,  peakY: 8,  maxY: 24, veins: 3.8,  size: 9 },
  { seed: 22, block: B.iron_ore,     minY: 2,  peakY: 12, maxY: 44, veins: 14.3, size: 10 },
  { seed: 51, block: B.copper_ore,   minY: 4,  peakY: 18, maxY: 48, veins: 8.6,  size: 11 },
  { seed: 11, block: B.coal_ore,     minY: 2,  peakY: 26, maxY: 64, veins: 27,   size: 14 }
];

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const IS_ORE = new Uint8Array(BLOCKS.length);
for (const o of ORE_TABLE) IS_ORE[o.block] = 1;

// 三角形分布反采样：把 [0,1) 的随机数映射成 y，峰值落在 peakY，两端 minY/maxY 收到 0。
function veinY(o, u) {
  const left = o.peakY - o.minY, right = o.maxY - o.peakY, total = left + right;
  if (total <= 0) return o.minY;
  if (u * total < left) return o.minY + Math.round(Math.sqrt(u * left * total));
  return o.maxY - Math.round(Math.sqrt((1 - u) * right * total));
}

// 这一格的 6 个邻居里有没有别的矿脉。
function touchesOre(data, lx, y, lz) {
  for (let d = 0; d < 6; d++) {
    const ny = y + DIRS[d][1];
    if (ny < 0 || ny >= HEIGHT) continue;
    const nx = lx + DIRS[d][0], nz = lz + DIRS[d][2];
    if (nx < 0 || nx >= CHUNK || nz < 0 || nz >= CHUNK) continue;
    if (IS_ORE[data[nx + CHUNK * (nz + CHUNK * ny)]]) return true;
  }
  return false;
}

// 从锚点长一条矿脉：每次从已长出的格子里随机挑一格、随机挑一个方向，是石头就变成矿。
// 新格子不许紧挨着别的矿脉——否则两条独立的脉会粘成一坨，统计出来的「一脉」就变成上百格。
// 先攒在 cells 里、最后一次性写进 data，中途就能靠「已写进去的」判断哪些是别的脉。
// 长满 o.size 格或试够次数就停，size 是硬上限。
function placeVein(data, lx, lz, ay, o, hx, hv, hz) {
  const cells = [lx + CHUNK * (lz + CHUNK * ay)];
  for (let step = 0; cells.length < o.size && step < o.size * 6; step++) {
    const from = cells[(hash3(hx, hv, hz, o.seed + 500 + step) * cells.length) | 0];
    const fy = (from / (CHUNK * CHUNK)) | 0;
    const r = from - fy * CHUNK * CHUNK;
    const fz = (r / CHUNK) | 0;
    const fx = r - fz * CHUNK;
    const d = (hash3(hx, hv + step, hz, o.seed + 900) * 6) | 0;
    const nx = fx + DIRS[d][0], ny = fy + DIRS[d][1], nz = fz + DIRS[d][2];
    if (nx < 0 || nx >= CHUNK || nz < 0 || nz >= CHUNK) continue;
    if (ny < 1 || ny >= HEIGHT) continue;
    const nidx = nx + CHUNK * (nz + CHUNK * ny);
    if (data[nidx] !== B.stone) continue;
    if (cells.indexOf(nidx) >= 0) continue;
    if (touchesOre(data, nx, ny, nz)) continue;
    cells.push(nidx);
  }
  for (let i = 0; i < cells.length; i++) data[cells[i]] = o.block;
}

function hash3(x, y, z, s) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177) + (s | 0);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const hCache = new Map();
const bCache = new Map();

const CACHE_OFF = 1048576;
const CACHE_SPAN = 2097152;
const ck = (x, z) => (x + CACHE_OFF) * CACHE_SPAN + (z + CACHE_OFF);

function mountainMaskAt(x, z) {
  return smoothstep(0.10, 0.55, fbm2(x / 320 + 120.5, z / 320 - 71.3, 2, 2, 0.5));
}

export function terrainHeight(x, z) {
  const key = ck(x, z);
  const c = hCache.get(key);
  if (c !== undefined) return c;
  const cont = fbm2(x / 380, z / 380, 4, 2, 0.5);
  const hills = fbm2(x / 95, z / 95, 4, 2, 0.5);
  const mtn = ridged2(x / 210, z / 210, 4, 2, 0.5);
  const mm = mountainMaskAt(x, z);
  let h = SEA + 2 + cont * 15 + hills * 6;
  h += Math.pow(Math.max(0, mtn), 2) * 40 * mm;
  let v = Math.floor(h);
  if (v < 4) v = 4;
  if (v > HEIGHT - 6) v = HEIGHT - 6;
  if (hCache.size > 400000) hCache.clear();
  hCache.set(key, v);
  return v;
}

export function biomeAt(x, z) {
  const key = ck(x, z);
  const c = bCache.get(key);
  if (c !== undefined) return c;
  const mm = mountainMaskAt(x, z);
  const th = terrainHeight(x, z);
  const temp = fbm2(x / 520, z / 520, 2, 2, 0.5);
  const humid = fbm2(x / 470 + 300.7, z / 470 - 210.3, 2, 2, 0.5);
  let b;
  if (mm > 0.45 && th > SEA + 16) b = 'mountains';
  else if (temp > 0.22 && humid < 0.10) b = 'desert';
  else if (temp < -0.26) b = 'snowy';
  else if (humid > 0.12) b = 'forest';
  else b = 'plains';
  if (bCache.size > 400000) bCache.clear();
  bCache.set(key, b);
  return b;
}

export function generateChunk(ch) {
  const { cx, cz, data, surface } = ch;
  const ox = cx * CHUNK, oz = cz * CHUNK;

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = ox + lx, z = oz + lz;
      const h = terrainHeight(x, z);
      const bio = biomeAt(x, z);
      surface[lx + CHUNK * lz] = h;
      const beach = h <= SEA + 1 && bio !== 'desert' && bio !== 'mountains';

      for (let y = 0; y <= h; y++) {
        let id;
        if (y === 0) id = B.bedrock;
        else if (y === h) {
          if (bio === 'desert') id = B.sand;
          else if (bio === 'mountains') id = (h > 52) ? B.snow_block : (h > 44 ? B.stone : B.gravel);
          else if (bio === 'snowy') id = B.snow_block;
          else if (beach) id = B.sand;
          else id = B.grass;
        } else if (y > h - 4) {
          if (bio === 'desert') id = B.sand;
          else if (bio === 'mountains') id = B.stone;
          else if (beach) id = B.sand;
          else id = B.dirt;
        } else if (bio === 'desert' && y > h - 8) {
          id = B.sandstone;
        } else {
          id = B.stone;
        }
        data[lx + CHUNK * (lz + CHUNK * y)] = id;
      }
      for (let y = h + 1; y <= SEA; y++) {
        if (bio === 'snowy' || (bio === 'mountains' && h > 44)) data[lx + CHUNK * (lz + CHUNK * y)] = B.ice;
        else data[lx + CHUNK * (lz + CHUNK * y)] = B.water;
      }
    }
  }

  const caveBottom = 2;
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = ox + lx, z = oz + lz;
      const h = surface[lx + CHUNK * lz];
      const top = Math.min(h - 3, HEIGHT - 12);
      for (let y = caveBottom; y <= top; y++) {
        const n = perlin3(x / 26, y / 15, z / 26) + 0.5 * perlin3(x / 13, y / 8, z / 13);
        if (n > 0.32) data[lx + CHUNK * (lz + CHUNK * y)] = AIR;
      }
    }
  }

  // 矿石：每种矿在每个区块撒 veins 个锚点，y 按三角形分布抽，锚点必须落在石头里。
  // 锚点落在空中或洞穴里就换个位置重抽，重抽 4 次都落不进石头，这条脉作废（山地部分出界也靠这个兜住）。
  for (const o of ORE_TABLE) {
    const nf = o.veins * ORE_DENSITY;
    const n = Math.floor(nf) + (hash3(ox, 7, oz, o.seed + 5000) < nf - Math.floor(nf) ? 1 : 0);
    for (let v = 0; v < n; v++) {
      for (let t = 0; t < 4; t++) {
        const lx = (hash3(ox, v * 2 + t * 5000, oz, o.seed + 1) * CHUNK) | 0;
        const lz = (hash3(ox, v * 2 + 1 + t * 5000, oz, o.seed + 2) * CHUNK) | 0;
        const ay = veinY(o, hash3(ox, v + t * 7000, oz, o.seed + 3));
        if (ay < 1 || ay >= HEIGHT) continue;
        if (o.biome && biomeAt(ox + lx, oz + lz) !== o.biome) continue;
        if (data[lx + CHUNK * (lz + CHUNK * ay)] !== B.stone) continue;
        if (touchesOre(data, lx, ay, lz)) continue;
        placeVein(data, lx, lz, ay, o, ox, v * 4 + t, oz);
        break;
      }
    }
  }

  // 基岩放在洞穴之后：洞穴从 y=2 起挖，会掏空底部，基岩必须在最后把底封回来，
  // 否则玩家能挖穿世界掉出去。y=0 全满，y=1..4 逐层递减成齿状（原版风格）。
  for (let y = 0; y < BEDROCK_CHANCE.length; y++) {
    const chance = BEDROCK_CHANCE[y];
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        if (chance < 1 && hash3(ox + lx, y, oz + lz, 7331) >= chance) continue;
        data[lx + CHUNK * (lz + CHUNK * y)] = B.bedrock;
      }
    }
  }

  const setIn = (x, y, z, id) => {
    if (y < 0 || y >= HEIGHT) return;
    const lx = x - ox, lz = z - oz;
    if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) return;
    const idx = lx + CHUNK * (lz + CHUNK * y);
    if (id === B.leaves) {
      if (data[idx] !== AIR) return;
    }
    data[idx] = id;
  };

  for (let oz2 = -2; oz2 < CHUNK + 2; oz2++) {
    for (let ox2 = -2; ox2 < CHUNK + 2; ox2++) {
      const x = ox + ox2, z = oz + oz2;
      const bio = biomeAt(x, z);
      let dens = 0;
      if (bio === 'forest') dens = 0.075;
      else if (bio === 'plains') dens = 0.012;
      else if (bio === 'snowy') dens = 0.055;
      if (dens === 0) continue;
      const r = hash2(x, z, 991);
      if (r >= dens) continue;
      const h = terrainHeight(x, z);
      if (h <= SEA + 1) continue;
      if (bio === 'snowy') plantSpruce(x, h + 1, z, setIn, hash2(x, z, 77));
      else plantOak(x, h + 1, z, setIn, hash2(x, z, 77));
    }
  }

  ch.generated = true;
}

function plantOak(x, y0, z, setIn, rnd) {
  const r = (n) => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return (rnd % 1000) / 1000;
  };
  const th = 4 + Math.floor(r(0) * 3);
  for (let i = 0; i < th; i++) setIn(x, y0 + i, z, B.log);
  const topY = y0 + th - 1;
  for (let dy = -2; dy <= 0; dy++) {
    const rad = dy === 0 ? 1 : 2;
    const yy = topY + dy + 1;
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx === 0 && dz === 0) continue;
        if (Math.abs(dx) === rad && Math.abs(dz) === rad && r(1) < 0.55) continue;
        setIn(x + dx, yy, z + dz, B.leaves);
      }
    }
  }
  setIn(x, topY + 2, z, B.leaves);
}

function plantSpruce(x, y0, z, setIn, rnd) {
  const r = (n) => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return (rnd % 1000) / 1000;
  };
  const th = 6 + Math.floor(r(0) * 3);
  for (let i = 0; i < th; i++) setIn(x, y0 + i, z, B.spruce_log);
  let rad = 2;
  for (let y = y0 + 2; y < y0 + th; y++) {
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx === 0 && dz === 0 && y < y0 + th - 1) continue;
        if (Math.abs(dx) === rad && Math.abs(dz) === rad && r(1) < 0.7) continue;
        setIn(x + dx, y, z + dz, B.spruce_leaves);
      }
    }
    if (y >= y0 + th - 3) rad = 1;
  }
  setIn(x, y0 + th, z, B.spruce_leaves);
}
