export function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function hash2(x, y, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const PERM = new Uint8Array(512);
(() => {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1]
];

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

export function perlin2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[X] + Y] & 7;
  const ab = PERM[PERM[X] + Y + 1] & 7;
  const ba = PERM[PERM[X + 1] + Y] & 7;
  const bb = PERM[PERM[X + 1] + Y + 1] & 7;
  const n00 = GRAD2[aa][0] * xf + GRAD2[aa][1] * yf;
  const n10 = GRAD2[ba][0] * (xf - 1) + GRAD2[ba][1] * yf;
  const n01 = GRAD2[ab][0] * xf + GRAD2[ab][1] * (yf - 1);
  const n11 = GRAD2[bb][0] * (xf - 1) + GRAD2[bb][1] * (yf - 1);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 0.7;
}

export function perlin3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const X = xi & 255, Y = yi & 255, Z = zi & 255;
  const A = PERM[X] + Y, B = PERM[X + 1] + Y;
  const AA = PERM[A] + Z, AB = PERM[A + 1] + Z;
  const BA = PERM[B] + Z, BB = PERM[B + 1] + Z;

  const g = (h, dx, dy, dz) => {
    const i = h & 7;
    const G = GRAD2[i];
    return G[0] * dx + G[1] * dy + (i < 4 ? dz * 0.5 : -dz * 0.5);
  };

  const x1 = lerp(g(PERM[AA], xf, yf, zf), g(PERM[BA], xf - 1, yf, zf), u);
  const x2 = lerp(g(PERM[AB], xf, yf - 1, zf), g(PERM[BB], xf - 1, yf - 1, zf), u);
  const y1 = lerp(x1, x2, v);
  const x3 = lerp(g(PERM[AA + 1], xf, yf, zf - 1), g(PERM[BA + 1], xf - 1, yf, zf - 1), u);
  const x4 = lerp(g(PERM[AB + 1], xf, yf - 1, zf - 1), g(PERM[BB + 1], xf - 1, yf - 1, zf - 1), u);
  const y2 = lerp(x3, x4, v);
  return lerp(y1, y2, w) * 0.8;
}

export function fbm2(x, y, octaves, lacunarity, gain) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(x, y, z, octaves, lacunarity, gain) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin3(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function ridged2(x, y, octaves, lacunarity, gain) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(perlin2(x * freq, y * freq)) * 2;
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
