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

console.log('\n===== 10. 掉落物 5 分钟消失（原版 6000 tick） =====');
// spawn() 要画布贴图，Node 里没有 —— 直接往 list 里塞一条假记录测 update 逻辑。
const { DroppedItems } = await import('../js/entities.js');
const THREE = await import('../js/vendor/three.module.js');
const stoneId = BLOCK_BY_KEY.stone.id;
const scene = { add() {}, remove() {} };
const fakeWorld = { getBlock: (x, y, z) => (y === 9 ? stoneId : 0), getMeta: () => 0 };
const drops = new DroppedItems(scene, fakeWorld, null);
const farPlayer = { x: 9999, y: 9999, z: 9999 };
const inv = { add: (id, n) => n };
const DT = 1 / 60;

function dropAt() {
  drops.list.push({
    id: stoneId, count: 1, dmg: 0,
    pos: new THREE.Vector3(0.5, 10.12, 0.5), vel: new THREE.Vector3(),
    age: 0, born: 1, spin: 0, sprite: new THREE.Sprite()
  });
}
dropAt();
// 真实帧步长跑 299 秒：不掉穿地板（顺带验了「贴着地面休息」这条老路径）
for (let f = 0; f < 299 * 60; f++) drops.update(DT, farPlayer, inv, null);
check('299 秒时还在（还没到消失时间）', drops.list.length === 1, 'list=' + drops.list.length);
check('299 秒内一直贴在石头面上没掉穿', drops.list.length === 1 && Math.abs(drops.list[0].pos.y - 10.12) < 0.01,
  drops.list.length ? 'y=' + drops.list[0].pos.y.toFixed(3) : '已经没了');
for (let f = 0; f < 2 * 60; f++) drops.update(DT, farPlayer, inv, null);
check('301 秒时消失了（原版 5 分钟）', drops.list.length === 0, 'list=' + drops.list.length);

// 对照：没被时间删掉的掉落物，摔出世界照样删（老行为没坏）
dropAt();
drops.list[0].pos.y = -30;
drops.update(DT, farPlayer, inv, null);
check('摔出世界（y < -20）照样消失', drops.list.length === 0, 'list=' + drops.list.length);

console.log('\n----------------------------------------------');
console.log('通过 ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
