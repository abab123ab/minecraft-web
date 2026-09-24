import { BLOCKS, AIR } from './blocks.js';
import { CHUNK, HEIGHT } from './worlddef.js';

const ITER = 15;
const VOL = CHUNK * CHUNK * HEIGHT;

const oldSky = new Uint8Array(VOL);
const oldLit = new Uint8Array(VOL);

const EDGE = [];
for (let y = 0; y < HEIGHT; y++) {
  for (let a = 0; a < CHUNK; a++) {
    EDGE.push(a + CHUNK * (CHUNK * y));
    EDGE.push(a + CHUNK * (CHUNK - 1 + CHUNK * y));
    EDGE.push(CHUNK * (a + CHUNK * y));
    EDGE.push(CHUNK - 1 + CHUNK * (a + CHUNK * y));
  }
}

export function computeChunkLight(ch, getChunk) {
  const data = ch.data, sky = ch.skyLight, lit = ch.blockLight;
  // 树叶（cutout）算「能透光」，但要扣 1 级 —— 原版树叶的 lightOpacity 就是 1。
  // 以前把树叶当全不透明处理，一片树冠底下天光直接归零，整座森林暗成一片。
  // 不透明方块照旧一格都透不过去。
  const cost = (id) => (BLOCKS[id] && BLOCKS[id].cutout) ? 1 : 0;
  const open = (id) => id === AIR || (BLOCKS[id] && (!BLOCKS[id].opaque || BLOCKS[id].cutout));

  const skyNbr = [], litNbr = [];
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const n = getChunk(ch.cx + i, ch.cz + j);
      skyNbr.push(n ? n.skyLight : null);
      litNbr.push(n ? n.blockLight : null);
    }
  }
  const pick = (arrs, x, y, z) => {
    if (y < 0 || y >= HEIGHT) return 0;
    const ix = x < 0 ? 0 : (x > CHUNK - 1 ? 2 : 1);
    const iz = z < 0 ? 0 : (z > CHUNK - 1 ? 2 : 1);
    const arr = arrs[iz * 3 + ix];
    if (!arr) return 0;
    return arr[(x - (ix - 1) * CHUNK) + CHUNK * ((z - (iz - 1) * CHUNK) + CHUNK * y)];
  };

  oldSky.set(sky);
  oldLit.set(lit);
  sky.fill(0);
  lit.fill(0);

  for (let y = HEIGHT - 1; y >= 0; y--) {
    for (let x = 0; x < CHUNK; x++) {
      for (let z = 0; z < CHUNK; z++) {
        const i = x + CHUNK * (z + CHUNK * y);
        if (!open(data[i])) continue;
        if (y === HEIGHT - 1) { sky[i] = 15; continue; }
        const above = i + CHUNK * CHUNK;
        if (open(data[above])) sky[i] = Math.max(0, sky[above] - cost(data[above]));
      }
    }
  }

  for (let iter = 0; iter < ITER; iter++) {
    let touched = false;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < CHUNK; x++) {
        for (let z = 0; z < CHUNK; z++) {
          const i = x + CHUNK * (z + CHUNK * y);
          if (!open(data[i])) continue;
          const self = cost(data[i]);
          let best = sky[i];
          let v;
          v = pick(skyNbr, x - 1, y, z) - 1 - self; if (v > best) best = v;
          v = pick(skyNbr, x + 1, y, z) - 1 - self; if (v > best) best = v;
          v = pick(skyNbr, x, y, z - 1) - 1 - self; if (v > best) best = v;
          v = pick(skyNbr, x, y, z + 1) - 1 - self; if (v > best) best = v;
          v = pick(skyNbr, x, y + 1, z) - 1 - self; if (v > best) best = v;
          if (best > sky[i]) { sky[i] = best; touched = true; }
        }
      }
    }
    if (!touched) break;
  }

  for (let i = 0; i < VOL; i++) {
    const id = data[i];
    lit[i] = BLOCKS[id] ? BLOCKS[id].light : 0;
  }

  for (let iter = 0; iter < ITER; iter++) {
    let touched = false;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < CHUNK; x++) {
        for (let z = 0; z < CHUNK; z++) {
          const i = x + CHUNK * (z + CHUNK * y);
          const id = data[i];
          if (!open(id)) continue;
          const self = cost(id);
          let best = lit[i];
          let v;
          v = pick(litNbr, x - 1, y, z) - 1 - self; if (v > best) best = v;
          v = pick(litNbr, x + 1, y, z) - 1 - self; if (v > best) best = v;
          v = pick(litNbr, x, y, z - 1) - 1 - self; if (v > best) best = v;
          v = pick(litNbr, x, y, z + 1) - 1 - self; if (v > best) best = v;
          v = pick(litNbr, x, y - 1, z) - 1 - self; if (v > best) best = v;
          v = pick(litNbr, x, y + 1, z) - 1 - self; if (v > best) best = v;
          if (best > lit[i]) { lit[i] = best; touched = true; }
        }
      }
    }
    if (!touched) break;
  }

  // 邻块只会读到本块最外那一圈（x/z = 0 或 15），所以只有这一圈变了才需要让邻块重算，
  // 否则光是内部重新分布也会引发整片区块反复重建。
  for (let e = 0; e < EDGE.length; e++) {
    const i = EDGE[e];
    if (sky[i] !== oldSky[i] || lit[i] !== oldLit[i]) return true;
  }
  return false;
}
