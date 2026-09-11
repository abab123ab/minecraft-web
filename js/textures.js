export const TILE = 16;
export const ATLAS_COLS = 16;
export const ATLAS_SIZE = TILE * ATLAS_COLS;

export const TILE_NAMES = [];
export const TILE_INDEX = {};

const BLOCK_TILES = {
  grass_top: 'grass_block_top',
  grass_side: 'grass_block_side',
  dirt: 'dirt',
  stone: 'stone',
  cobblestone: 'cobblestone',
  planks: 'oak_planks',
  log_side: 'oak_log',
  log_top: 'oak_log_top',
  leaves: 'oak_leaves',
  spruce_log_side: 'spruce_log',
  spruce_log_top: 'spruce_log_top',
  spruce_leaves: 'spruce_leaves',
  sand: 'sand',
  sandstone_side: 'sandstone',
  sandstone_top: 'sandstone_top',
  gravel: 'gravel',
  snow: 'snow',
  snow_side: 'grass_block_snow',
  ice: 'ice',
  glass: 'glass',
  coal_ore: 'coal_ore',
  iron_ore: 'iron_ore',
  gold_ore: 'gold_ore',
  diamond_ore: 'diamond_ore',
  copper_ore: 'copper_ore',
  redstone_ore: 'redstone_ore',
  lapis_ore: 'lapis_ore',
  emerald_ore: 'emerald_ore',
  obsidian: 'obsidian',
  bedrock: 'bedrock',
  water: 'water_still',
  wool: 'white_wool',
  furnace_front: 'furnace_front',
  furnace_side: 'furnace_side',
  furnace_top: 'furnace_top',
  crafting_top: 'crafting_table_top',
  crafting_side: 'crafting_table_side',
  torch: 'torch',
  bed: 'bed'
};

const ITEM_TILES = [
  'stick', 'coal', 'iron_ingot', 'gold_ingot', 'diamond', 'copper_ingot', 'redstone', 'lapis_lazuli', 'emerald', 'apple',
  'porkchop', 'beef', 'chicken', 'mutton', 'rotten_flesh',
  'cooked_porkchop', 'cooked_beef', 'cooked_chicken', 'cooked_mutton',
  'leather', 'feather', 'bone', 'arrow', 'gunpowder',
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe',
  'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe',
  'wooden_shovel', 'stone_shovel', 'iron_shovel', 'diamond_shovel',
  'leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots',
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots',
  'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'
];

const CRACK_TILES = [
  'destroy_stage_0', 'destroy_stage_1', 'destroy_stage_2', 'destroy_stage_3',
  'destroy_stage_4', 'destroy_stage_5', 'destroy_stage_6', 'destroy_stage_7',
  'destroy_stage_8', 'destroy_stage_9'
];

export const ASSET_COUNT = Object.keys(BLOCK_TILES).length + ITEM_TILES.length + CRACK_TILES.length;

const TINT = {
  grass_top: [121, 192, 90],
  leaves: [89, 174, 48],
  spruce_leaves: [97, 153, 97],
  water: [63, 118, 228]
};

const OPAQUE = { leaves: 1, spruce_leaves: 1 };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('贴图加载失败: ' + src));
    img.src = src;
  });
}

export async function buildAtlas(base) {
  base = base || 'textures/';
  const names = [];
  const srcs = [];
  for (const key in BLOCK_TILES) {
    names.push(key);
    srcs.push(base + 'block/' + BLOCK_TILES[key] + '.png');
  }
  for (const key of ITEM_TILES) {
    names.push(key);
    srcs.push(base + 'item/' + key + '.png');
  }
  CRACK_TILES.forEach((file, i) => {
    names.push('crack_' + i);
    srcs.push(base + 'block/' + file + '.png');
  });

  const images = await Promise.all(srcs.map(loadImage));

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  names.forEach((name, i) => {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    const x = col * TILE;
    const y = row * TILE;
    ctx.drawImage(images[i], 0, 0, TILE, TILE, x, y, TILE, TILE);
    if (OPAQUE[name]) fillHoles(ctx, x, y);
    const tint = TINT[name];
    if (tint) applyTint(ctx, x, y, tint);
    TILE_NAMES.push(name);
    TILE_INDEX[name] = i;
  });

  return canvas;
}

function fillHoles(ctx, x, y) {
  const d = ctx.getImageData(x, y, TILE, TILE);
  const p = d.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] > 8) { r += p[i]; g += p[i + 1]; b += p[i + 2]; n++; }
  }
  if (!n) return;
  r = (r / n) * 0.8;
  g = (g / n) * 0.8;
  b = (b / n) * 0.8;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] <= 8) { p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = 255; }
  }
  ctx.putImageData(d, x, y);
}

function applyTint(ctx, x, y, tint) {
  const d = ctx.getImageData(x, y, TILE, TILE);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    p[i] = p[i] * tint[0] / 255;
    p[i + 1] = p[i + 1] * tint[1] / 255;
    p[i + 2] = p[i + 2] * tint[2] / 255;
  }
  ctx.putImageData(d, x, y);
}

export function tileUV(index) {
  const col = index % ATLAS_COLS;
  const row = (index / ATLAS_COLS) | 0;
  const s = 1 / ATLAS_COLS;
  return { u0: col * s, v0: 1 - (row + 1) * s, u1: (col + 1) * s, v1: 1 - row * s };
}
