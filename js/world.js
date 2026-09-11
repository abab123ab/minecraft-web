export const CHUNK = 16;
export const HEIGHT = 80;
export const SECTION = 16;
export const SEC_COUNT = HEIGHT / SECTION;
export const SEA = 30;

import { fbm2, ridged2, perlin3, hash2 } from './noise.js';
import { BLOCKS, AIR } from './blocks.js';
import { tileUV, TILE_INDEX } from './textures.js';
import * as THREE from './vendor/three.module.js';

const B = {};
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

export const BIOMES = ['plains', 'forest', 'desert', 'snowy', 'mountains'];

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

const FACES = [
  {
    dir: [1, 0, 0], tile: 1, shade: 0.72, uAxis: [0, 0, -1], vAxis: [0, 1, 0],
    verts: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    dir: [-1, 0, 0], tile: 1, shade: 0.72, uAxis: [0, 0, 1], vAxis: [0, 1, 0],
    verts: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    dir: [0, 1, 0], tile: 0, shade: 1.0, uAxis: [1, 0, 0], vAxis: [0, 0, -1],
    verts: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    dir: [0, -1, 0], tile: 2, shade: 0.50, uAxis: [1, 0, 0], vAxis: [0, 0, 1],
    verts: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    dir: [0, 0, 1], tile: 1, shade: 0.88, uAxis: [1, 0, 0], vAxis: [0, 1, 0],
    verts: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  },
  {
    dir: [0, 0, -1], tile: 1, shade: 0.88, uAxis: [-1, 0, 0], vAxis: [0, 1, 0],
    verts: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]]
  }
];

const CORNER_SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function solidForAO(id) {
  return BLOCKS[id].opaque;
}

export class World {
  constructor(scene, atlasCanvas, edits) {
    this.scene = scene;
    this.chunks = new Map();
    this.pending = [];
    this.dirty = new Set();
    this.edits = edits || new Map();
    this.renderDistance = 4;
    this.useAO = true;
    this.dayness = 1.0;

    const tex = new THREE.CanvasTexture(atlasCanvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this.atlasTexture = tex;
    this.atlasCanvas = atlasCanvas;

    this.matOpaque = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, color: 0xffffff });
    this.matWater = new THREE.MeshBasicMaterial({
      map: tex, vertexColors: true, transparent: true, opacity: 0.72,
      depthWrite: false, side: THREE.DoubleSide, color: 0xffffff
    });
    this.matGlass = new THREE.MeshBasicMaterial({
      map: tex, vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, side: THREE.DoubleSide, color: 0xffffff
    });
  }

  lightAt(x, y, z) {
    if (y < 0 || y >= HEIGHT) return { sky: 0, lit: 0 };
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const ch = this.chunks.get(this.key(cx, cz));
    if (!ch || !ch.skyLight) return { sky: 0, lit: 0 };
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const idx = lx + CHUNK * (lz + CHUNK * y);
    return { sky: ch.skyLight[idx], lit: ch.blockLight[idx] };
  }

  key(cx, cz) { return cx + '|' + cz; }

  getChunk(cx, cz) { return this.chunks.get(this.key(cx, cz)); }

  getBlock(x, y, z) {
    if (y < 0 || y >= HEIGHT) return AIR;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const ch = this.chunks.get(this.key(cx, cz));
    if (!ch) return AIR;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    return ch.data[lx + CHUNK * (lz + CHUNK * y)];
  }

  setBlock(x, y, z, id) {
    if (y < 0 || y >= HEIGHT) return;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const ch = this.chunks.get(this.key(cx, cz));
    if (!ch) return;
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const idx = lx + CHUNK * (lz + CHUNK * y);
    this.recordEdit(cx, cz, idx, id, ch.data[idx]);
    ch.data[idx] = id;
    this.markSections(cx, cz, y - 1, y + 1);
    if (lx === 0) this.markSections(cx - 1, cz, y - 1, y + 1);
    if (lx === CHUNK - 1) this.markSections(cx + 1, cz, y - 1, y + 1);
    if (lz === 0) this.markSections(cx, cz - 1, y - 1, y + 1);
    if (lz === CHUNK - 1) this.markSections(cx, cz + 1, y - 1, y + 1);
  }

  markDirty(cx, cz) {
    const ch = this.chunks.get(this.key(cx, cz));
    if (!ch) return;
    ch.secDirty.fill(1);
    this.dirty.add(ch);
  }

  markSections(cx, cz, y0, y1) {
    const ch = this.chunks.get(this.key(cx, cz));
    if (!ch) return;
    const s0 = Math.max(0, (y0 / SECTION) | 0);
    const s1 = Math.min(SEC_COUNT - 1, (y1 / SECTION) | 0);
    for (let s = s0; s <= s1; s++) ch.secDirty[s] = 1;
    this.dirty.add(ch);
  }

  recordEdit(cx, cz, idx, id, prev) {
    if (id === prev) return;
    const k = this.key(cx, cz);
    let m = this.edits.get(k);
    if (!m) { m = new Map(); this.edits.set(k, m); }
    const rec = m.get(idx);
    if (rec) {
      rec[1] = id;
      if (rec[1] === rec[0]) m.delete(idx);
    } else {
      m.set(idx, [prev, id]);
    }
  }

  applyEdits(ch) {
    const m = this.edits.get(this.key(ch.cx, ch.cz));
    if (!m) return;
    for (const [idx, rec] of m) ch.data[idx] = rec[1];
  }

  ensureChunk(cx, cz) {
    const k = this.key(cx, cz);
    let ch = this.chunks.get(k);
    if (ch) return ch;
    ch = {
      cx, cz,
      data: new Uint8Array(CHUNK * CHUNK * HEIGHT),
      skyLight: new Uint8Array(CHUNK * CHUNK * HEIGHT),
      blockLight: new Uint8Array(CHUNK * CHUNK * HEIGHT),
      surface: new Uint8Array(CHUNK * CHUNK),
      generated: false,
      secDirty: new Uint8Array(SEC_COUNT).fill(1),
      secs: Array.from({ length: SEC_COUNT }, () => ({ o: null, w: null, g: null }))
    };
    this.chunks.set(k, ch);
    this.generate(ch);
    this.applyEdits(ch);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.markDirty(cx + dx, cz + dz);
    }
    return ch;
  }

  generate(ch) {
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

  update(playerX, playerZ, budgetMs) {
    const pcx = Math.floor(playerX / CHUNK), pcz = Math.floor(playerZ / CHUNK);
    const rd = this.renderDistance;
    const want = [];
    for (let dz = -rd; dz <= rd; dz++) {
      for (let dx = -rd; dx <= rd; dx++) {
        if (dx * dx + dz * dz > rd * rd + rd) continue;
        const cx = pcx + dx, cz = pcz + dz;
        if (!this.chunks.has(this.key(cx, cz))) want.push([cx, cz, dx * dx + dz * dz]);
      }
    }
    want.sort((a, b) => a[2] - b[2]);

    const t0 = performance.now();
    for (const w of want) {
      this.ensureChunk(w[0], w[1]);
      if (performance.now() - t0 > budgetMs) break;
    }

    const t1 = performance.now();
    let over = false;
    for (const ch of this.dirty) {
      for (let s = 0; s < SEC_COUNT; s++) {
        if (!ch.secDirty[s]) continue;
        this.buildSection(ch, s);
        ch.secDirty[s] = 0;
        if (performance.now() - t1 > budgetMs) { over = true; break; }
      }
      let left = 0;
      for (let s = 0; s < SEC_COUNT; s++) if (ch.secDirty[s]) left++;
      if (left === 0) this.dirty.delete(ch);
      if (over) break;
    }

    const maxD = (rd + 1) * (rd + 1) * CHUNK * CHUNK;
    for (const [k, ch] of this.chunks) {
      const dx = (ch.cx - pcx) * CHUNK, dz = (ch.cz - pcz) * CHUNK;
      if (dx * dx + dz * dz > maxD) {
        this.disposeChunk(ch);
        this.chunks.delete(k);
      }
    }
  }

  disposeChunk(ch) {
    for (const s of ch.secs) {
      for (const m of [s.o, s.w, s.g]) {
        if (m) { this.scene.remove(m); m.geometry.dispose(); }
      }
      s.o = s.w = s.g = null;
    }
    this.dirty.delete(ch);
  }

  markAllDirty() {
    for (const ch of this.chunks.values()) this.markDirty(ch);
  }

  computeSectionLight(ch, si) {
    const data = ch.data;
    const sky = ch.skyLight;
    const lit = ch.blockLight;
    const y0 = si * SECTION, y1 = Math.min(HEIGHT, y0 + SECTION);
    const idxAt = (x, y, z) => x + CHUNK * (z + CHUNK * y);
    const isSkyOpen = (id) => id === AIR || (BLOCKS[id] && !BLOCKS[id].opaque);

    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < CHUNK; x++) for (let z = 0; z < CHUNK; z++) {
        const i = idxAt(x, y, z);
        sky[i] = 0; lit[i] = 0;
      }
    }

    for (let y = HEIGHT - 1; y >= y0; y--) {
      for (let x = 0; x < CHUNK; x++) for (let z = 0; z < CHUNK; z++) {
        const i = idxAt(x, y, z);
        if (!isSkyOpen(data[i])) continue;
        if (y === HEIGHT - 1) { sky[i] = 15; continue; }
        const above = idxAt(x, y + 1, z);
        if (isSkyOpen(data[above]) && sky[above] === 15) sky[i] = 15;
      }
    }

    for (let iter = 0; iter < 8; iter++) {
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < CHUNK; x++) for (let z = 0; z < CHUNK; z++) {
          const i = idxAt(x, y, z);
          if (!isSkyOpen(data[i])) continue;
          let best = sky[i];
          if (x > 0) best = Math.max(best, sky[i - 1] - 1);
          if (x < CHUNK - 1) best = Math.max(best, sky[i + 1] - 1);
          if (z > 0) best = Math.max(best, sky[i - CHUNK] - 1);
          if (z < CHUNK - 1) best = Math.max(best, sky[i + CHUNK] - 1);
          if (y < HEIGHT - 1) {
            const above = idxAt(x, y + 1, z);
            if (isSkyOpen(data[above])) best = Math.max(best, sky[above] - 1);
          }
          if (best > sky[i]) sky[i] = best;
        }
      }
    }

    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < CHUNK; x++) for (let z = 0; z < CHUNK; z++) {
        const i = idxAt(x, y, z);
        const id = data[i];
        lit[i] = BLOCKS[id] ? BLOCKS[id].light : 0;
      }
    }
    for (let iter = 0; iter < 8; iter++) {
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < CHUNK; x++) for (let z = 0; z < CHUNK; z++) {
          const i = idxAt(x, y, z);
          const id = data[i];
          if (id !== AIR && BLOCKS[id].opaque) continue;
          let best = lit[i];
          if (x > 0) best = Math.max(best, lit[i - 1] - 1);
          if (x < CHUNK - 1) best = Math.max(best, lit[i + 1] - 1);
          if (z > 0) best = Math.max(best, lit[i - CHUNK] - 1);
          if (z < CHUNK - 1) best = Math.max(best, lit[i + CHUNK] - 1);
          if (y > y0) best = Math.max(best, lit[i - CHUNK * CHUNK] - 1);
          if (y < y1 - 1) best = Math.max(best, lit[i + CHUNK * CHUNK] - 1);
          if (best > lit[i]) lit[i] = best;
        }
      }
    }
  }

  buildSection(ch, si) {
    const grid = [];
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const n = this.chunks.get(this.key(ch.cx + i, ch.cz + j));
        grid.push(n ? n.data : null);
      }
    }
    const get = (x, y, z) => {
      if (y < 0 || y >= HEIGHT) return AIR;
      const ix = x < 0 ? 0 : (x > 15 ? 2 : 1);
      const iz = z < 0 ? 0 : (z > 15 ? 2 : 1);
      const arr = grid[iz * 3 + ix];
      if (!arr) return AIR;
      return arr[(x - (ix - 1) * 16) + CHUNK * ((z - (iz - 1) * 16) + CHUNK * y)];
    };

    const opaque = { pos: [], uv: [], col: [], idx: [] };
    const water = { pos: [], uv: [], col: [], idx: [] };
    const glass = { pos: [], uv: [], col: [], idx: [] };

    const data = ch.data;
    const surface = ch.surface;

    const yStart = si * SECTION, yEnd = yStart + SECTION;

    for (let y = yStart; y < yEnd; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          const id = data[x + CHUNK * (z + CHUNK * y)];
          if (id === AIR) continue;
          const block = BLOCKS[id];
          const tiles = block.tiles;
          if (!tiles) continue;

          if (id === B.torch) {
            addTorchQuads(opaque, x, y, z, tiles);
            continue;
          }

          for (let f = 0; f < 6; f++) {
            const face = FACES[f];
            const nb = get(x + face.dir[0], y + face.dir[1], z + face.dir[2]);
            const nbBlock = BLOCKS[nb];
            if (nbBlock.opaque && !(nb === id && block.transparent)) continue;
            if (block.liquid) {
              if (nb === id) continue;
              if (face.dir[1] === -1) continue;
              if (face.dir[1] === 1 && nb !== AIR) continue;
            }

            const target = block.liquid ? water : (block.transparent ? glass : opaque);
            const tileName = tiles[face.tile];
            const ti = TILE_INDEX[tileName];
            const uvR = tileUV(ti === undefined ? 0 : ti);

            const base = target.pos.length / 3;
            const ao = [0, 0, 0, 0];
            const aboveAir = get(x, y + 1, z) === AIR;
            const waterTop = block.liquid && aboveAir ? 0.875 : 1;
            for (let v = 0; v < 4; v++) {
              const vtx = face.verts[v];
              const uvs = face.uvs[v];
              const sign = CORNER_SIGNS[v];
              const px = x + vtx[0];
              const py = y + vtx[1] * waterTop;
              const pz = z + vtx[2];

              let aoLevel = 3;
              if (this.useAO) {
                const s1 = solidForAO(get(
                  x + face.dir[0] + face.uAxis[0] * sign[0],
                  y + face.dir[1] + face.uAxis[1] * sign[0],
                  z + face.dir[2] + face.uAxis[2] * sign[0]
                )) ? 1 : 0;
                const s2 = solidForAO(get(
                  x + face.dir[0] + face.vAxis[0] * sign[1],
                  y + face.dir[1] + face.vAxis[1] * sign[1],
                  z + face.dir[2] + face.vAxis[2] * sign[1]
                )) ? 1 : 0;
                const cnr = solidForAO(get(
                  x + face.dir[0] + face.uAxis[0] * sign[0] + face.vAxis[0] * sign[1],
                  y + face.dir[1] + face.uAxis[1] * sign[0] + face.vAxis[1] * sign[1],
                  z + face.dir[2] + face.uAxis[2] * sign[0] + face.vAxis[2] * sign[1]
                )) ? 1 : 0;
                aoLevel = (s1 && s2) ? 0 : 3 - (s1 + s2 + cnr);
              }
              ao[v] = aoLevel;

              const aof = 0.55 + 0.15 * ao[v];
              const idxHere = x + CHUNK * (z + CHUNK * y);
              const skyL = ch.skyLight[idxHere];
              const litL = ch.blockLight[idxHere];
              const skyV = skyL / 15;
              const litV = litL / 15;
              let lv = skyV + litV;
              if (lv < 0.30) lv = 0.30;
              const warm = Math.max(0, litL - skyL) / 15;
              const r = Math.min(1, lv + warm * 0.18);
              const g = Math.min(1, lv + warm * 0.06);
              const b = Math.max(0, lv - warm * 0.06);
              const shade = face.shade * aof;
              target.pos.push(px, py, pz);
              target.uv.push(
                uvR.u0 + (uvR.u1 - uvR.u0) * uvs[0],
                uvR.v0 + (uvR.v1 - uvR.v0) * uvs[1]
              );
              target.col.push(r * shade, g * shade, b * shade);
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

    this.computeSectionLight(ch, si);
    this.setMesh(ch, si, 'o', opaque, this.matOpaque, 0);
    this.setMesh(ch, si, 'g', glass, this.matGlass, 1);
    this.setMesh(ch, si, 'w', water, this.matWater, 2);
  }

  buildMesh(ch) {
    for (let s = 0; s < SEC_COUNT; s++) this.buildSection(ch, s);
    ch.secDirty.fill(0);
    this.dirty.delete(ch);
  }

  setMesh(ch, si, prop, buf, material, order) {
    const sec = ch.secs[si];
    const old = sec[prop];
    if (old) { this.scene.remove(old); old.geometry.dispose(); sec[prop] = null; }
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
    this.scene.add(mesh);
  }

  raycast(origin, dir, maxDist) {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / dir.x), tDeltaY = Math.abs(1 / dir.y), tDeltaZ = Math.abs(1 / dir.z);
    const bx = dir.x > 0 ? (x + 1 - origin.x) : (origin.x - x);
    const by = dir.y > 0 ? (y + 1 - origin.y) : (origin.y - y);
    const bz = dir.z > 0 ? (z + 1 - origin.z) : (origin.z - z);
    let tMaxX = tDeltaX === Infinity ? Infinity : bx * tDeltaX;
    let tMaxY = tDeltaY === Infinity ? Infinity : by * tDeltaY;
    let tMaxZ = tDeltaZ === Infinity ? Infinity : bz * tDeltaZ;
    let nx = 0, ny = 0, nz = 0;
    let t = 0;

    while (t <= maxDist) {
      const id = this.getBlock(x, y, z);
      if (id !== AIR && !BLOCKS[id].liquid) {
        return { x, y, z, nx, ny, nz, id };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (y < -1 || y > HEIGHT) break;
    }
    return null;
  }
}

function addTorchQuads(target, x, y, z, tiles) {
  const ti = TILE_INDEX[tiles[1]];
  const uvR = tileUV(ti === undefined ? 0 : ti);
  const W = 0.20, H = 0.60;
  const x0 = x + 0.5 - W / 2, x1 = x + 0.5 + W / 2;
  const z0 = z + 0.5 - W / 2, z1 = z + 0.5 + W / 2;
  const yb = y, yt = y + H;
  const quads = [
    { pts: [[x1, yb, z1], [x1, yb, z0], [x1, yt, z0], [x1, yt, z1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], shade: 0.7 },
    { pts: [[x0, yb, z0], [x0, yb, z1], [x0, yt, z1], [x0, yt, z0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], shade: 0.7 },
    { pts: [[x0, yb, z1], [x1, yb, z1], [x1, yt, z1], [x0, yt, z1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], shade: 0.88 },
    { pts: [[x1, yb, z0], [x0, yb, z0], [x0, yt, z0], [x1, yt, z0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], shade: 0.88 },
    { pts: [[x0, yt, z0], [x1, yt, z0], [x1, yt, z1], [x0, yt, z1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], shade: 1.0 }
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
