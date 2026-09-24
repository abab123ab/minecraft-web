import { BLOCKS, TOOL_MATERIALS } from './blocks.js';
import { TILE_INDEX } from './textures.js';

export const ITEMS = [];
export const ITEM_BY_KEY = {};

ITEMS.push({ id: 0, key: 'empty', label: '', blockId: 0, stack: 1, tile: null, tool: null, fuel: 0 });

function item(key, opts) {
  const it = Object.assign({
    id: ITEMS.length,
    key,
    label: key,
    blockId: 0,
    stack: 64,
    tile: null,
    tool: null,
    fuel: 0,
    food: null,
    attack: null,
    armor: null
  }, opts);
  ITEMS.push(it);
  ITEM_BY_KEY[key] = it;
  return it;
}

BLOCKS.forEach((b) => {
  if (b.key === 'air' || b.key === 'water') return;
  item(b.key, { label: b.label, blockId: b.id, tile: b.tiles ? b.tiles[1] : null });
});

item('stick', { label: '木棍', tile: 'stick', fuel: 5 });
item('coal', { label: '煤炭', tile: 'coal', fuel: 80 });
item('iron_ingot', { label: '铁锭', tile: 'iron_ingot' });
item('gold_ingot', { label: '金锭', tile: 'gold_ingot' });
item('diamond', { label: '钻石', tile: 'diamond' });
item('copper_ingot', { label: '铜锭', tile: 'copper_ingot' });
item('redstone', { label: '红石粉', tile: 'redstone' });
item('lapis_lazuli', { label: '青金石', tile: 'lapis_lazuli' });
item('emerald', { label: '绿宝石', tile: 'emerald' });
item('apple', { label: '苹果', tile: 'apple', food: { hunger: 4, saturation: 2.4 } });

item('porkchop', { label: '生猪排', tile: 'porkchop', food: { hunger: 3, saturation: 1.8 } });
item('beef', { label: '生牛肉', tile: 'beef', food: { hunger: 3, saturation: 1.8 } });
item('chicken', { label: '生鸡肉', tile: 'chicken', food: { hunger: 2, saturation: 1.2 } });
item('mutton', { label: '生羊肉', tile: 'mutton', food: { hunger: 2, saturation: 1.2 } });
item('rotten_flesh', { label: '腐肉', tile: 'rotten_flesh', food: { hunger: 4, saturation: 0.8 } });

item('cooked_porkchop', { label: '熟猪排', tile: 'cooked_porkchop', food: { hunger: 8, saturation: 12.8 } });
item('cooked_beef', { label: '牛排', tile: 'cooked_beef', food: { hunger: 8, saturation: 12.8 } });
item('cooked_chicken', { label: '熟鸡肉', tile: 'cooked_chicken', food: { hunger: 6, saturation: 7.2 } });
item('cooked_mutton', { label: '熟羊肉', tile: 'cooked_mutton', food: { hunger: 6, saturation: 9.6 } });

item('leather', { label: '皮革', tile: 'leather' });
item('feather', { label: '羽毛', tile: 'feather' });
item('bone', { label: '骨头', tile: 'bone' });
item('arrow', { label: '箭', tile: 'arrow' });
item('gunpowder', { label: '火药', tile: 'gunpowder' });

ITEM_BY_KEY.planks.fuel = 15;
ITEM_BY_KEY.log.fuel = 15;
ITEM_BY_KEY.crafting_table.fuel = 15;
ITEM_BY_KEY.stick.fuel = 5;

const TOOL_LABEL = { pickaxe: '镐', axe: '斧', shovel: '铲' };
const TOOL_ATTACK = {
  pickaxe: [0, 2, 3, 4, 5],
  axe: [0, 7, 9, 9, 9],
  shovel: [0, 2.5, 3.5, 4.5, 5.5]
};
export const FIST_ATTACK = 1;

for (const mat in TOOL_MATERIALS) {
  const m = TOOL_MATERIALS[mat];
  for (const kind of ['pickaxe', 'axe', 'shovel']) {
    const key = mat + '_' + kind;
    item(key, {
      label: m.label + TOOL_LABEL[kind],
      tile: key,
      stack: 1,
      tool: { type: kind, tier: m.tier, speed: m.speed, durability: m.durability },
      attack: TOOL_ATTACK[kind][m.tier]
    });
  }
}

const ARMOR_MATERIALS = {
  leather: { label: '皮革', points: [1, 3, 2, 1], toughness: 0 },
  iron: { label: '铁', points: [2, 6, 5, 2], toughness: 0 },
  golden: { label: '金', points: [1, 5, 3, 1], toughness: 0 },
  diamond: { label: '钻石', points: [3, 8, 6, 3], toughness: 2 }
};
const ARMOR_SLOTS = [
  { key: 'helmet', label: '头盔' },
  { key: 'chestplate', label: '胸甲' },
  { key: 'leggings', label: '护腿' },
  { key: 'boots', label: '靴子' }
];
export const ARMOR_SLOT_KEYS = ARMOR_SLOTS.map((s) => s.key);

for (const mat in ARMOR_MATERIALS) {
  const m = ARMOR_MATERIALS[mat];
  for (let i = 0; i < 4; i++) {
    const s = ARMOR_SLOTS[i];
    item(mat + '_' + s.key, {
      label: m.label + s.label,
      tile: mat + '_' + s.key,
      stack: 1,
      armor: { slot: i, points: m.points[i], toughness: m.toughness }
    });
  }
}

export function itemId(key) { return ITEM_BY_KEY[key].id; }

export function armorStats(armor) {
  let points = 0;
  let toughness = 0;
  for (const s of armor) {
    if (!s) continue;
    const a = ITEMS[s.id].armor;
    if (!a) continue;
    points += a.points;
    toughness += a.toughness;
  }
  return { points, toughness };
}

export function itemTileIndex(it) {
  if (!it.tile) return -1;
  const idx = TILE_INDEX[it.tile];
  return idx === undefined ? -1 : idx;
}

const iconCache = new Map();

// 缓存键必须带上尺寸：手持物品要 72px、背包格子要 32px，同一个物品两张都要。
// 原来只按 it.id 缓存，谁先要谁定尺寸 —— 背包先画，手持就拿 32px 的图标放大 2.25 倍，边缘发虚。
export function itemIconCanvas(atlasCanvas, it, size) {
  const s = size || 32;
  const ck = it.id + '@' + s;
  let cached = iconCache.get(ck);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (it.blockId) {
    const b = BLOCKS[it.blockId];
    if (b && b.flat) {
      const idx = itemTileIndex(it);
      if (idx >= 0) {
        const col = idx % 16, row = (idx / 16) | 0;
        ctx.drawImage(atlasCanvas, col * 16, row * 16, 16, 16, 0, 0, s, s);
      }
    } else {
      drawIsoCube(ctx, atlasCanvas, b, s);
    }
  } else {
    const idx = itemTileIndex(it);
    if (idx >= 0) {
      const col = idx % 16, row = (idx / 16) | 0;
      ctx.drawImage(atlasCanvas, col * 16, row * 16, 16, 16, 0, 0, s, s);
    }
  }
  iconCache.set(ck, c);
  return c;
}

function drawIsoCube(ctx, atlas, block, s) {
  const T = 16;
  const idxOf = (name) => {
    const i = TILE_INDEX[name];
    return i === undefined ? 0 : i;
  };
  const tileXY = (i) => [(i % 16) * T, ((i / 16) | 0) * T];

  const cx = s / 2;
  const topH = s * 0.26;
  const sideH = s * 0.46;

  const drawQuad = (tileName, pts, shade) => {
    const [tx, ty] = tileXY(idxOf(tileName));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(atlas, tx, ty, T, T, minX, minY, maxX - minX, maxY - minY);
    ctx.fillStyle = 'rgba(0,0,0,' + (1 - shade).toFixed(3) + ')';
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.restore();
  };

  const top = [[cx, 0], [s, topH], [cx, topH * 2], [0, topH]];
  const left = [[0, topH], [cx, topH * 2], [cx, topH * 2 + sideH], [0, topH + sideH]];
  const right = [[cx, topH * 2], [s, topH], [s, topH + sideH], [cx, topH * 2 + sideH]];

  const tiles = block.tiles || ['stone', 'stone', 'stone'];
  drawQuad(tiles[0], top, 1.0);
  drawQuad(tiles[1], left, 0.70);
  drawQuad(tiles[1], right, 0.86);
}
