import * as THREE from './vendor/three.module.js';
import { BLOCKS, AIR } from './blocks.js';
import { CHUNK, HEIGHT, SECTION, SEC_COUNT } from './worlddef.js';
import { generateChunk } from './worldgen.js';
import { computeChunkLight } from './lighting.js';
import { buildSectionBatches, setSectionMesh } from './mesher.js';

const MAX_LIGHT_ROUNDS = 6;

export class World {
  constructor(scene, atlasCanvas, edits) {
    this.scene = scene;
    this.chunks = new Map();
    this.dirty = new Set();
    this.edits = edits || new Map();
    this.renderDistance = 4;
    this.useAO = true;
    this.dayness = 1.0;

    const tex = new THREE.CanvasTexture(atlasCanvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    // 图集里的贴图颜色是「显示器上的颜色」（sRGB），必须如实声明，
    // 否则 three 不把它当 sRGB 解码，直接拿编码值当线性值算，
    // 最后输出时又编码一遍 —— 整个世界的方块会整体亮一大截、颜色发白。
    // 生物贴图一直有这一行，方块没有，所以只有生物是正常浓淡。
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this.atlasTexture = tex;
    this.atlasCanvas = atlasCanvas;

    this.matOpaque = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, color: 0xffffff });
    // 镂空通道：树叶、床这种贴图里有「全透明像素」的方块。不透明混合、靠 alphaTest
    // 直接丢弃透明像素 —— 这样深度照样写，后面该挡的东西还是挡得住，
    // 不像玻璃那样要关 depthWrite 再排渲染顺序。
    // DoubleSide 是给树叶用的：叶隙里能看见叶子背面的那一层。
    this.matCutout = new THREE.MeshBasicMaterial({
      map: tex, vertexColors: true, alphaTest: 0.5,
      side: THREE.DoubleSide, color: 0xffffff
    });
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
    ch.lightStale = 1;
    this.dirty.add(ch);
  }

  markSections(cx, cz, y0, y1) {
    const ch = this.chunks.get(this.key(cx, cz));
    if (!ch) return;
    const s0 = Math.max(0, (y0 / SECTION) | 0);
    const s1 = Math.min(SEC_COUNT - 1, (y1 / SECTION) | 0);
    for (let s = s0; s <= s1; s++) ch.secDirty[s] = 1;
    ch.lightStale = 1;
    this.dirty.add(ch);
  }

  // 光照是整块一个整体（只增不减地扩散），邻块会读本块最外一圈，所以本块光照一变，
  // 4 个邻块必须跟着重算；不然区块边界上会出现一条光被硬切断的缝。
  // 光照值单调递增且上限 15，反复触发必然收敛，update() 里再用轮数上限保底。
  markLightNeighbors(ch) {
    for (let d = 0; d < 4; d++) {
      const dx = d === 0 ? -1 : (d === 1 ? 1 : 0);
      const dz = d === 2 ? -1 : (d === 3 ? 1 : 0);
      const n = this.chunks.get(this.key(ch.cx + dx, ch.cz + dz));
      if (!n || n.lightStale) continue;
      n.lightStale = 1;
      n.secDirty.fill(1);
      this.dirty.add(n);
    }
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
      lightStale: 1,
      secs: Array.from({ length: SEC_COUNT }, () => ({ o: null, c: null, w: null, g: null }))
    };
    this.chunks.set(k, ch);
    generateChunk(ch);
    this.applyEdits(ch);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.markDirty(cx + dx, cz + dz);
    }
    return ch;
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
    let rounds = 0;
    // 光照外溢到邻块会让邻块重新进 dirty，所以整段可能要跑好几轮才收敛。
    // 光照单调递增且上限 15，轮数有天然上界，这里再给个硬上限免得卡帧。
    while (this.dirty.size > 0 && rounds < MAX_LIGHT_ROUNDS) {
      rounds++;
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
      for (const m of [s.o, s.c, s.w, s.g]) {
        if (m) { this.scene.remove(m); m.geometry.dispose(); }
      }
      s.o = s.c = s.w = s.g = null;
    }
    this.dirty.delete(ch);
  }

  buildSection(ch, si) {
    // 光照按整块算一次（每 16 格一 section 切开算会让光在 y=16/32/48/64 处断掉），
    // 且必须在建面之前算：网格顶点色取的是面外侧那一格的光照。
    if (ch.lightStale) {
      ch.lightStale = 0;
      const spilled = computeChunkLight(ch, (cx, cz) => this.chunks.get(this.key(cx, cz)));
      // 光照一变，本块所有 section 的顶点色全部作废，不能只重建被编辑的那一层。
      ch.secDirty.fill(1);
      if (spilled) this.markLightNeighbors(ch);
    }
    const ctx = {
      getChunk: (cx, cz) => this.chunks.get(this.key(cx, cz)),
      useAO: this.useAO
    };
    const { opaque, cutout, glass, water } = buildSectionBatches(ch, si, ctx);
    setSectionMesh(this.scene, ch, si, 'o', opaque, this.matOpaque, 0);
    setSectionMesh(this.scene, ch, si, 'c', cutout, this.matCutout, 1);
    setSectionMesh(this.scene, ch, si, 'g', glass, this.matGlass, 2);
    setSectionMesh(this.scene, ch, si, 'w', water, this.matWater, 3);
  }

  buildMesh(ch) {
    ch.lightStale = 1;
    for (let s = 0; s < SEC_COUNT; s++) this.buildSection(ch, s);
    ch.secDirty.fill(0);
    this.dirty.delete(ch);
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
