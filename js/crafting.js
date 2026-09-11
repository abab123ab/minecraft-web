import { ITEM_BY_KEY, ITEMS } from './items.js';

const K = (key) => ITEM_BY_KEY[key].id;
const isToolStack = (s) => !!ITEMS[s.id].tool;

export const RECIPES = [];

function shaped(pattern, keyMap, resultKey, count) {
  const trimmed = trimPattern(pattern);
  RECIPES.push({
    type: 'shaped',
    pattern: trimmed.rows,
    w: trimmed.w,
    h: trimmed.h,
    key: keyMap,
    result: K(resultKey),
    count: count || 1,
    resultKey
  });
}

function shapeless(itemKeys, resultKey, count) {
  RECIPES.push({
    type: 'shapeless',
    items: itemKeys.map(K),
    result: K(resultKey),
    count: count || 1,
    resultKey
  });
}

function trimPattern(rows) {
  let minR = rows.length, maxR = -1, minC = rows[0].length, maxC = -1;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== ' ') {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }
  const out = [];
  for (let r = minR; r <= maxR; r++) out.push(rows[r].slice(minC, maxC + 1).replace(/ /g, '\0'));
  return { rows: out, w: maxC - minC + 1, h: maxR - minR + 1 };
}

shapeless(['log'], 'planks', 4);
shaped(['P', 'P'], { P: 'planks' }, 'stick', 4);
shaped(['C', 'S'], { C: 'coal', S: 'stick' }, 'torch', 4);
shaped(['W', 'W', 'W', 'P', 'P', 'P'], { W: 'wool', P: 'planks' }, 'bed', 1);
shaped(['PP', 'PP'], { P: 'planks' }, 'crafting_table', 1);
shaped(['SS', 'SS'], { S: 'sand' }, 'sandstone', 1);
shaped(['CCC', 'C C', 'CCC'], { C: 'cobblestone' }, 'furnace', 1);

const TOOL_MATS = [
  { mat: 'wooden', item: 'planks' },
  { mat: 'stone', item: 'cobblestone' },
  { mat: 'iron', item: 'iron_ingot' },
  { mat: 'diamond', item: 'diamond' }
];

for (const t of TOOL_MATS) {
  const M = t.item;
  shaped(['MMM', ' S ', ' S '], { M, S: 'stick' }, t.mat + '_pickaxe', 1);
  shaped(['MM', 'MS', ' S'], { M, S: 'stick' }, t.mat + '_axe', 1);
  shaped(['M', 'S', 'S'], { M, S: 'stick' }, t.mat + '_shovel', 1);
}

const ARMOR_MATS = [
  { mat: 'leather', item: 'leather' },
  { mat: 'iron', item: 'iron_ingot' },
  { mat: 'golden', item: 'gold_ingot' },
  { mat: 'diamond', item: 'diamond' }
];

for (const a of ARMOR_MATS) {
  const M = a.item;
  shaped(['MMM', 'M M'], { M }, a.mat + '_helmet', 1);
  shaped(['M M', 'MMM', 'MMM'], { M }, a.mat + '_chestplate', 1);
  shaped(['MMM', 'M M', 'M M'], { M }, a.mat + '_leggings', 1);
  shaped(['M M', 'M M'], { M }, a.mat + '_boots', 1);
}

RECIPES.sort((a, b) => (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0));

export const SMELTING = [
  { input: K('iron_ore'), output: K('iron_ingot'), time: 10 },
  { input: K('gold_ore'), output: K('gold_ingot'), time: 10 },
  { input: K('copper_ore'), output: K('copper_ingot'), time: 10 },
  { input: K('sand'), output: K('glass'), time: 10 },
  { input: K('cobblestone'), output: K('stone'), time: 10 },
  { input: K('log'), output: K('coal'), time: 10 },
  { input: K('porkchop'), output: K('cooked_porkchop'), time: 8 },
  { input: K('beef'), output: K('cooked_beef'), time: 8 },
  { input: K('chicken'), output: K('cooked_chicken'), time: 8 },
  { input: K('mutton'), output: K('cooked_mutton'), time: 8 }
];

export function smeltRecipe(itemId) {
  return SMELTING.find((s) => s.input === itemId) || null;
}

export function matchRecipe(grid, size) {
  for (const rec of RECIPES) {
    if (rec.type === 'shapeless') {
      const cells = matchShapeless(grid, size, rec);
      if (cells) return { recipe: rec, cells };
    } else {
      if (rec.w > size || rec.h > size) continue;
      const cells = matchShaped(grid, size, rec);
      if (cells) return { recipe: rec, cells };
    }
  }
  return null;
}

function matchShapeless(grid, size, rec) {
  const need = rec.items.slice();
  const cells = [];
  for (let i = 0; i < size * size; i++) {
    const s = grid[i];
    if (!s) continue;
    if (isToolStack(s)) return null;
    const pos = need.indexOf(s.id);
    if (pos === -1) return null;
    need.splice(pos, 1);
    cells.push(i);
  }
  return need.length === 0 && cells.length > 0 ? cells : null;
}

function matchShaped(grid, size, rec) {
  for (let oy = 0; oy + rec.h <= size; oy++) {
    for (let ox = 0; ox + rec.w <= size; ox++) {
      const cells = [];
      let ok = true;
      for (let r = 0; r < rec.h && ok; r++) {
        for (let c = 0; c < rec.w && ok; c++) {
          const ch = rec.pattern[r][c];
          const gi = (oy + r) * size + (ox + c);
          const s = grid[gi];
          if (ch === '\0') {
            if (s) ok = false;
          } else {
            const want = rec.key[ch];
            if (!s || s.id !== K(want) || isToolStack(s)) ok = false;
            else cells.push(gi);
          }
        }
      }
      if (!ok) continue;
      for (let i = 0; i < size * size && ok; i++) {
        if (cells.indexOf(i) === -1 && grid[i]) ok = false;
      }
      if (ok && cells.length > 0) return cells;
    }
  }
  return null;
}
