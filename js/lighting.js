import { BLOCKS, AIR } from './blocks.js';
import { CHUNK, HEIGHT, SECTION } from './worlddef.js';

export function computeSectionLight(ch, si) {
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
