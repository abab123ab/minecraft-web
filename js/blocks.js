export const AIR = 0;

export const BLOCKS = [];
export const BLOCK_BY_KEY = {};

function def(key, opts) {
  const b = Object.assign({
    id: BLOCKS.length,
    key,
    label: key,
    tiles: null,
    hardness: 1,
    tool: null,
    tier: 0,
    requiresTool: false,
    dropCount: 1,
    solid: true,
    opaque: true,
    transparent: false,
    cutout: false,
    liquid: false,
    unbreakable: false,
    bonusDrop: null,
    light: 0,
    sound: 'stone'
  }, opts);
  BLOCKS.push(b);
  BLOCK_BY_KEY[key] = b;
  return b;
}

def('air', { solid: false, opaque: false, unbreakable: true });

// cutout：贴图里带「全透明」的像素，渲染时要直接丢弃，不能当不透明方块画。
// 树叶的图 32.8%（云杉 37.5%）是镂空的叶隙 —— 以前靠 textures.js 的补洞把叶隙
// 填成一个平色，整棵树就成了一块不透明的绿板，从树里抬头只能看见一片绿天花板。
def('stone', { label: '石头', tiles: ['stone', 'stone', 'stone'], hardness: 1.5, tool: 'pickaxe', tier: 1, requiresTool: true, drop: 'cobblestone' });
def('grass', { label: '草方块', tiles: ['grass_top', 'grass_side', 'dirt'], hardness: 0.6, tool: 'shovel', tier: 0, drop: 'dirt', sound: 'grass' });
def('dirt', { label: '泥土', tiles: ['dirt', 'dirt', 'dirt'], hardness: 0.5, tool: 'shovel', tier: 0, sound: 'dirt' });
def('cobblestone', { label: '圆石', tiles: ['cobblestone', 'cobblestone', 'cobblestone'], hardness: 2.0, tool: 'pickaxe', tier: 1, requiresTool: true });
def('planks', { label: '木板', tiles: ['planks', 'planks', 'planks'], hardness: 2.0, tool: 'axe', tier: 0, sound: 'wood' });
def('log', { label: '橡树原木', tiles: ['log_top', 'log_side', 'log_top'], hardness: 2.0, tool: 'axe', tier: 0, sound: 'wood' });
def('leaves', { label: '橡树树叶', tiles: ['leaves', 'leaves', 'leaves'], hardness: 0.2, tool: null, tier: 0, drop: null, bonusDrop: { key: 'apple', chance: 0.05 }, sound: 'leaves', cutout: true });
def('spruce_log', { label: '云杉原木', tiles: ['spruce_log_top', 'spruce_log_side', 'spruce_log_top'], hardness: 2.0, tool: 'axe', tier: 0, sound: 'wood' });
def('spruce_leaves', { label: '云杉树叶', tiles: ['spruce_leaves', 'spruce_leaves', 'spruce_leaves'], hardness: 0.2, tool: null, tier: 0, drop: null, sound: 'leaves', cutout: true });
def('sand', { label: '沙子', tiles: ['sand', 'sand', 'sand'], hardness: 0.5, tool: 'shovel', tier: 0, sound: 'sand' });
def('sandstone', { label: '砂岩', tiles: ['sandstone_top', 'sandstone_side', 'sandstone_top'], hardness: 0.8, tool: 'pickaxe', tier: 1, requiresTool: true });
def('gravel', { label: '沙砾', tiles: ['gravel', 'gravel', 'gravel'], hardness: 0.6, tool: 'shovel', tier: 0, sound: 'gravel' });
def('snow_block', { label: '雪', tiles: ['snow', 'snow_side', 'dirt'], hardness: 0.2, tool: 'shovel', tier: 0, requiresTool: true, sound: 'dirt' });
def('ice', { label: '冰', tiles: ['ice', 'ice', 'ice'], hardness: 0.5, tool: 'pickaxe', tier: 1, requiresTool: true });
def('wool', { label: '白色羊毛', tiles: ['wool', 'wool', 'wool'], hardness: 0.8, tool: null, tier: 0, sound: 'wool' });
def('glass', { label: '玻璃', tiles: ['glass', 'glass', 'glass'], hardness: 0.3, tool: null, tier: 0, drop: null, opaque: false, transparent: true, sound: 'glass' });
def('crafting_table', { label: '工作台', tiles: ['crafting_top', 'crafting_side', 'planks'], hardness: 2.5, tool: 'axe', tier: 0, sound: 'wood' });
// tiles 是 [顶, 侧面, 底]。原来顶面写的是 furnace_side，导致 furnace_top 这张贴图
// 加载进图集却没人用，熔炉顶面看起来像个石砖面。
def('furnace', { label: '熔炉', tiles: ['furnace_top', 'furnace_front', 'furnace_side'], hardness: 3.5, tool: 'pickaxe', tier: 1, requiresTool: true });
def('coal_ore', { label: '煤矿石', tiles: ['coal_ore', 'coal_ore', 'coal_ore'], hardness: 3.0, tool: 'pickaxe', tier: 1, requiresTool: true, drop: 'coal', ore: true });
def('iron_ore', { label: '铁矿石', tiles: ['iron_ore', 'iron_ore', 'iron_ore'], hardness: 3.0, tool: 'pickaxe', tier: 2, requiresTool: true, ore: true });
def('gold_ore', { label: '金矿石', tiles: ['gold_ore', 'gold_ore', 'gold_ore'], hardness: 3.0, tool: 'pickaxe', tier: 3, requiresTool: true, ore: true });
def('diamond_ore', { label: '钻石矿石', tiles: ['diamond_ore', 'diamond_ore', 'diamond_ore'], hardness: 3.0, tool: 'pickaxe', tier: 3, requiresTool: true, drop: 'diamond', ore: true });
def('copper_ore', { label: '铜矿石', tiles: ['copper_ore', 'copper_ore', 'copper_ore'], hardness: 3.0, tool: 'pickaxe', tier: 1, requiresTool: true, ore: true });
def('redstone_ore', { label: '红石矿石', tiles: ['redstone_ore', 'redstone_ore', 'redstone_ore'], hardness: 3.0, tool: 'pickaxe', tier: 2, requiresTool: true, drop: 'redstone', ore: true });
def('lapis_ore', { label: '青金石矿石', tiles: ['lapis_ore', 'lapis_ore', 'lapis_ore'], hardness: 3.0, tool: 'pickaxe', tier: 2, requiresTool: true, drop: 'lapis_lazuli', ore: true, bonusDrop: { key: 'lapis_lazuli', chance: 0.5 } });
def('emerald_ore', { label: '绿宝石矿石', tiles: ['emerald_ore', 'emerald_ore', 'emerald_ore'], hardness: 3.0, tool: 'pickaxe', tier: 2, requiresTool: true, drop: 'emerald', ore: true });
def('obsidian', { label: '黑曜石', tiles: ['obsidian', 'obsidian', 'obsidian'], hardness: 50, tool: 'pickaxe', tier: 4, requiresTool: true });
def('bedrock', { label: '基岩', tiles: ['bedrock', 'bedrock', 'bedrock'], unbreakable: true });
def('water', {
  label: '水', tiles: ['water', 'water', 'water'],
  solid: false, opaque: false, transparent: true, liquid: true, unbreakable: true
});

def('torch', {
  label: '火把', tiles: ['torch', 'torch', 'torch'],
  hardness: 0.1, tool: null, tier: 0,
  solid: false, opaque: false, transparent: true, drop: 'torch', light: 14, flat: true, sound: 'wood'
});

// bed.png 是「床的侧面图」：白枕头 + 红被子 + 木头床架。它的顶部三行是镂空的
// （39/256 个像素全透明，RGB 是 0,0,0）—— 那是床垫上方的空间。
// 当不透明方块画的话，alpha 被忽略，这三行就直接变成一条黑带糊在床顶上。
def('bed', {
  label: '床', tiles: ['bed', 'bed', 'bed'],
  hardness: 0.4, tool: null, tier: 0,
  solid: true, opaque: true, transparent: false, cutout: true, drop: 'bed', light: 0, sound: 'wood'
});

export function isSolid(id) { return BLOCKS[id].solid; }
export function isLiquid(id) { return BLOCKS[id].liquid; }

export const TOOL_MATERIALS = {
  wooden: { tier: 1, speed: 2, durability: 60, label: '木' },
  stone: { tier: 2, speed: 4, durability: 132, label: '石' },
  iron: { tier: 3, speed: 6, durability: 251, label: '铁' },
  diamond: { tier: 4, speed: 8, durability: 1562, label: '钻石' }
};

export function breakTime(block, toolDef) {
  if (block.unbreakable) return Infinity;
  const h = block.hardness;
  const hasRightTool = !!toolDef && toolDef.type === block.tool && toolDef.tier >= block.tier;
  if (block.requiresTool) {
    if (!hasRightTool) return h * 5;
    return h * 1.5 / toolDef.speed;
  }
  const speed = hasRightTool ? toolDef.speed : 1;
  return h * 1.5 / speed;
}

export function canHarvest(block, toolDef) {
  if (!block.requiresTool) return true;
  return !!toolDef && toolDef.type === block.tool && toolDef.tier >= block.tier;
}
