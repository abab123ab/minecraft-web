import { fbm2, ridged2, perlin3, hash2 } from './noise.js';
import { BLOCKS, AIR } from './blocks.js';
import { CHUNK, HEIGHT, SEA } from './worlddef.js';

export const B = {};
function bid(key) { return BLOCKS.findIndex((b) => b.key === key); }
[
  'stone', 'grass', 'dirt', 'cobblestone', 'planks', 'log', 'leaves', 'sand', 'sandstone',
  'spruce_log', 'spruce_leaves',
  'gravel', 'snow_block', 'ice', 'glass', 'crafting_table', 'furnace', 'coal_ore', 'iron_ore',
  'gold_ore', 'diamond_ore', 'copper_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore',
  'obsidian', 'bedrock', 'water', 'wool', 'torch'
].forEach((k) => { B[k] = bid(k); });

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

  // Per-layer ore generation. Rare-first so deeper ores don't get starved by coal/copper.
  const ORE_TABLE = [
    { seed: 81, block: B.emerald_ore, minY: 6,  maxY: 34, pTop: 0.004, pBot: 0.009 },
    { seed: 44, block: B.diamond_ore, minY: 2,  maxY: 15, pTop: 0.005, pBot: 0.013 },
    { seed: 71, block: B.lapis_ore,   minY: 6,  maxY: 36, pTop: 0.008, pBot: 0.016 },
    { seed: 61, block: B.redstone_ore,minY: 2,  maxY: 20, pTop: 0.015, pBot: 0.030 },
    { seed: 33, block: B.gold_ore,    minY: 3,  maxY: 24, pTop: 0.010, pBot: 0.020 },
    { seed: 22, block: B.iron_ore,    minY: 3,  maxY: 40, pTop: 0.020, pBot: 0.040 },
    { seed: 51, block: B.copper_ore,  minY: 6,  maxY: 50, pTop: 0.030, pBot: 0.050 },
    { seed: 11, block: B.coal_ore,    minY: 6,  maxY: 52, pTop: 0.040, pBot: 0.065 }
  ];
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = ox + lx, z = oz + lz;
      const h = surface[lx + CHUNK * lz];
      for (let y = 1; y <= h; y++) {
        const idx = lx + CHUNK * (lz + CHUNK * y);
        if (data[idx] !== B.stone) continue;
        for (const o of ORE_TABLE) {
          if (y < o.minY || y > o.maxY) continue;
          const depth = (o.maxY - y) / (o.maxY - o.minY);
          const p = o.pTop + (o.pBot - o.pTop) * depth;
          if (hash3(x >> 1, y >> 1, z >> 1, o.seed) < p) { data[idx] = o.block; break; }
        }
      }
    }
  }

  // 把零散矿石扩成小矿脉（确定性，2 轮），让连锁挖矿能连成团块
  const ORE_IDS = new Set([
    B.coal_ore, B.copper_ore, B.iron_ore, B.gold_ore,
    B.redstone_ore, B.lapis_ore, B.emerald_ore, B.diamond_ore
  ]);
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let pass = 0; pass < 2; pass++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = ox + lx, z = oz + lz;
        const h = surface[lx + CHUNK * lz];
        for (let y = 1; y <= h; y++) {
          const idx = lx + CHUNK * (lz + CHUNK * y);
          const id = data[idx];
          if (!ORE_IDS.has(id)) continue;
          if (hash3(x >> 1, y >> 1, z >> 1, 97 + pass * 13 + id) >= 0.4) continue;
          const d = (hash3(x >> 1, y >> 1, z >> 1, 151 + pass * 13 + id) * 6) | 0;
          const dir = DIRS[d];
          const ny = y + dir[1];
          if (ny < 1 || ny > h) continue;
          const nx = x + dir[0], nz = z + dir[2];
          const lxx = nx - ox, lzz = nz - oz;
          if (lxx < 0 || lxx >= CHUNK || lzz < 0 || lzz >= CHUNK) continue;
          const nidx = lxx + CHUNK * (lzz + CHUNK * ny);
          if (data[nidx] === B.stone) data[nidx] = id;
        }
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
