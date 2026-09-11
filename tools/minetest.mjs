import { BLOCKS, BLOCK_BY_KEY, breakTime, canHarvest, TOOL_MATERIALS } from '../js/blocks.js';
import { ITEM_BY_KEY } from '../js/items.js';

const mats = ['wooden', 'stone', 'iron', 'diamond'];
const kinds = ['pickaxe', 'axe', 'shovel'];

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

const t = (k) => (k ? ITEM_BY_KEY[k].tool : null);
// 能采该方块的最低材质
function lowestMat(block) {
  return mats.find((m) => TOOL_MATERIALS[m].tier >= block.tier) || mats[mats.length - 1];
}

console.log('\n===== 1. 挖掘速度：正确工具必须比空手快 =====');
for (const b of BLOCKS) {
  if (b.unbreakable || b.key === 'air' || !b.tool) continue;
  const bare = breakTime(b, null);
  const withTool = breakTime(b, t(lowestMat(b) + '_' + b.tool));
  check(`${b.label}(${b.key}) 拿${b.tool}比空手快`, withTool < bare,
    `空手 ${bare.toFixed(2)}s → ${withTool.toFixed(2)}s`);
}

console.log('\n===== 2. 挖掘速度：材质越好越快（对该工具真正能挖的方块） =====');
for (const kind of kinds) {
  const b = BLOCKS.find((x) => x.tool === kind && x.requiresTool && x.tier <= 1);
  if (!b) continue;
  let prev = Infinity, ok = true;
  const seq = [];
  for (const m of mats) {
    const bt = breakTime(b, t(m + '_' + kind));
    seq.push(m + ' ' + bt.toFixed(2));
    if (bt >= prev) ok = false;
    prev = bt;
  }
  check(`${b.label} 用 ${kind}：木>石>铁>钻石 递减`, ok, seq.join(' | '));
}

console.log('\n===== 3. 挖掘速度对数值（原版参考，容差 0.15~0.8s） =====');
const ref = [
  ['stone', 'wooden_pickaxe', 1.15, 0.4],
  ['stone', 'diamond_pickaxe', 0.25, 0.15],
  ['cobblestone', 'wooden_pickaxe', 1.5, 0.5],
  ['coal_ore', 'wooden_pickaxe', 2.25, 0.8],
  ['iron_ore', 'stone_pickaxe', 1.15, 0.5],
  ['log', 'wooden_axe', 1.25, 0.6],
  ['dirt', 'wooden_shovel', 0.35, 0.3]
];
for (const [bk, tk, want, tol] of ref) {
  const got = breakTime(BLOCK_BY_KEY[bk], t(tk));
  check(`${bk} + ${tk} ≈ ${want}s`, Math.abs(got - want) <= tol, `实际 ${got.toFixed(2)}s`);
}

console.log('\n===== 4. 掉落：requiresTool 方块必须拿"够 tier 的工具"才掉 =====');
for (const b of BLOCKS) {
  if (!b.requiresTool || b.unbreakable) continue;
  check(`${b.label}(tier${b.tier}) 拿${lowestMat(b)}${b.tool}能掉落`,
    canHarvest(b, t(lowestMat(b) + '_' + b.tool)) === true);
  check(`${b.label} 空手不掉`, canHarvest(b, null) === false);
}

console.log('\n===== 5. 掉落：tier 门槛（原版 1.20 规则） =====');
check('铁矿石(tier2) + 木镐(tier1) 不能采', canHarvest(BLOCK_BY_KEY.iron_ore, t('wooden_pickaxe')) === false);
check('铁矿石(tier2) + 石镐(tier2) 能采', canHarvest(BLOCK_BY_KEY.iron_ore, t('stone_pickaxe')) === true);
check('金矿石(tier3) + 石镐(tier2) 不能采', canHarvest(BLOCK_BY_KEY.gold_ore, t('stone_pickaxe')) === false);
check('金矿石(tier3) + 铁镐(tier3) 能采', canHarvest(BLOCK_BY_KEY.gold_ore, t('iron_pickaxe')) === true);
check('钻石矿(tier3) + 石镐(tier2) 不能采', canHarvest(BLOCK_BY_KEY.diamond_ore, t('stone_pickaxe')) === false);
check('钻石矿(tier3) + 铁镐(tier3) 能采', canHarvest(BLOCK_BY_KEY.diamond_ore, t('iron_pickaxe')) === true);
check('黑曜石(tier4) + 铁镐(tier3) 不能采', canHarvest(BLOCK_BY_KEY.obsidian, t('iron_pickaxe')) === false);
check('黑曜石(tier4) + 钻石镐(tier4) 能采', canHarvest(BLOCK_BY_KEY.obsidian, t('diamond_pickaxe')) === true);

console.log('\n===== 6. 掉落：非 requiresTool 方块空手也掉 =====');
for (const k of ['dirt', 'log', 'sand', 'planks', 'grass', 'gravel', 'wool']) {
  check(`${BLOCK_BY_KEY[k].label} 空手能掉落`, canHarvest(BLOCK_BY_KEY[k], null) === true);
}

console.log('\n===== 7. 工具种类不能混用 =====');
check('木斧挖不了石头', canHarvest(BLOCK_BY_KEY.stone, t('wooden_axe')) === false);
check('木铲挖不了石头', canHarvest(BLOCK_BY_KEY.stone, t('wooden_shovel')) === false);
check('木镐挖不了雪(要铲)', canHarvest(BLOCK_BY_KEY.snow_block, t('wooden_pickaxe')) === false);
check('木铲挖得了雪', canHarvest(BLOCK_BY_KEY.snow_block, t('wooden_shovel')) === true);

console.log('\n===== 8. 不可破坏 =====');
check('基岩 breakTime = Infinity', breakTime(BLOCK_BY_KEY.bedrock, t('diamond_pickaxe')) === Infinity);
check('水 breakTime = Infinity', breakTime(BLOCK_BY_KEY.water, null) === Infinity);

console.log('\n===== 9. 玻璃/树叶特殊掉落 =====');
check('玻璃 drop = null（不掉）', BLOCK_BY_KEY.glass.drop === null);
check('树叶 drop = null（不掉）', BLOCK_BY_KEY.leaves.drop === null);
check('树叶有苹果 bonusDrop', !!BLOCK_BY_KEY.leaves.bonusDrop);
check('石头掉落圆石', BLOCK_BY_KEY.stone.drop === 'cobblestone');

console.log('\n----------------------------------------------');
console.log('通过 ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
