import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-mine-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=1024,640', '--user-data-dir=' + userDir
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDev() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return r.json(); } catch (e) {}
    await sleep(300);
  }
  throw new Error('devtools 未启动');
}
const version = await waitDev();

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.errors = []; this.session = null;
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id); resolve(msg); return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push('EXCEPTION: ' + (d.exception ? d.exception.description || d.exception.value : d.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    });
    this.ready = new Promise((r) => this.ws.addEventListener('open', r));
  }
  send(method, params) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (this.session) payload.sessionId = this.session;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
}

const cdp = new Cdp(version.webSocketDebuggerUrl);
await cdp.ready;
const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
const attached = await cdp.send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
cdp.session = attached.result.sessionId;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: APP });
await sleep(2500);

async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('evaluate 失败: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await ev('!!(window.game && window.game.world && window.game.mobs)');
  if (ready) break;
  await sleep(500);
}
check('游戏初始化完成', ready);
await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1500);
check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

// ---- A 拿木镐挖石头：速度 vs 空手 ----
const speed = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/items.js');
  const bmod = await import('/js/blocks.js');
  const stone = bmod.BLOCK_BY_KEY.stone;
  const woodPick = mod.ITEM_BY_KEY.wooden_pickaxe;
  const out = {};
  out.bare = bmod.breakTime(stone, null);
  out.woodPick = bmod.breakTime(stone, woodPick.tool);
  out.ratio = out.bare / out.woodPick;
  out.canHarvestBare = bmod.canHarvest(stone, null);
  out.canHarvestWood = bmod.canHarvest(stone, woodPick.tool);
  return out;
})()`);
check('木镐挖石头比空手快 5 倍以上', speed.ratio >= 5, `空手 ${speed.bare.toFixed(2)}s → 木镐 ${speed.woodPick.toFixed(2)}s（快 ${speed.ratio.toFixed(1)} 倍）`);
check('木镐挖石头时间 ≈ 1.1s', Math.abs(speed.woodPick - 1.125) < 0.05, speed.woodPick.toFixed(3) + 's');
check('空手挖不了石头（无掉落）', speed.canHarvestBare === false);
check('木镐能挖石头（有掉落）', speed.canHarvestWood === true);

// ---- B 实际挖：确认掉出圆石 ----
const mine = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/items.js');
  const bmod = await import('/js/blocks.js');
  g.dropped.clear();
  const IT = g.inventory;

  // 在玩家脚下前方铺一块石头
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z) - 3;
  g.world.setBlock(bx, by, bz, bmod.BLOCK_BY_KEY.stone.id);
  const placed = g.world.getBlock(bx, by, bz);

  // 空手挖
  IT.slots[0] = null; IT.selected = 0;
  g.dropped.clear();
  g.breakBlock(bx, by, bz);
  const bareDrops = g.dropped.list.length;

  // 木镐挖
  g.world.setBlock(bx, by, bz, bmod.BLOCK_BY_KEY.stone.id);
  IT.slots[0] = { id: mod.ITEM_BY_KEY.wooden_pickaxe.id, count: 1, dmg: 0 }; IT.selected = 0;
  g.dropped.clear();
  g.breakBlock(bx, by, bz);
  const woodDrops = g.dropped.list.length;
  const dropId = g.dropped.list.length ? g.dropped.list[0].id : -1;
  const dropIsCobble = dropId === mod.ITEM_BY_KEY.cobblestone.id;

  IT.slots[0] = null;
  g.dropped.clear();
  return { placed, placedIsStone: placed === bmod.BLOCK_BY_KEY.stone.id, bareDrops, woodDrops, dropIsCobble, durabilityUsed: true };
})()`);
check('测试用方块确实是石头', mine.placedIsStone, JSON.stringify(mine));
check('空手挖石头不掉物品', mine.bareDrops === 0, 'drops=' + mine.bareDrops);
check('木镐挖石头掉 1 个物品', mine.woodDrops === 1, 'drops=' + mine.woodDrops);
check('木镐挖石头掉的是圆石', mine.dropIsCobble, JSON.stringify(mine));

// ---- C 挖掘进度条：木镐比空手快 ----
const progress = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/items.js');
  const bmod = await import('/js/blocks.js');
  const IT = g.inventory;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z) - 3;
  const stoneId = bmod.BLOCK_BY_KEY.stone.id;

  function framesToBreak(toolId) {
    g.world.setBlock(bx, by, bz, stoneId);
    IT.slots[0] = toolId === null ? null : { id: toolId, count: 1, dmg: 0 };
    IT.selected = 0;
    g.mineState = null;
    // 精确瞄准石头中心
    const eye = g.player.eyePos();
    const tx = bx + 0.5, ty = by + 0.5, tz = bz + 0.5;
    const dx = tx - eye.x, dy = ty - eye.y, dz = tz - eye.z;
    const hd = Math.hypot(dx, dz);
    g.player.yaw = Math.atan2(-dx, -dz);
    g.player.targetYaw = g.player.yaw;
    g.player.pitch = Math.atan2(dy, hd);
    g.player.targetPitch = g.player.pitch;
    g.mining = true;
    let f = 0;
    for (; f < 3000; f++) {
      g.updateMining(0.016);
      if (g.world.getBlock(bx, by, bz) === 0) break;
    }
    g.mining = false;
    g.mineState = null;
    return f;
  }
  const bare = framesToBreak(null);
  const wood = framesToBreak(mod.ITEM_BY_KEY.wooden_pickaxe.id);
  const dia = framesToBreak(mod.ITEM_BY_KEY.diamond_pickaxe.id);
  IT.slots[0] = null;
  g.dropped.clear();
  return { bare, wood, dia, bareSec: (bare*0.016).toFixed(2), woodSec: (wood*0.016).toFixed(2), diaSec: (dia*0.016).toFixed(2) };
})()`);
check('实际挖：木镐帧数 < 空手帧数', progress.wood < progress.bare, `空手 ${progress.bare}帧(${progress.bareSec}s) → 木镐 ${progress.wood}帧(${progress.woodSec}s)`);
check('实际挖：钻石镐 < 木镐', progress.dia < progress.wood, `木镐 ${progress.wood}帧(${progress.woodSec}s) → 钻石镐 ${progress.dia}帧(${progress.diaSec}s)`);
check('实际挖：木镐 ≈ 1.1s', Math.abs(parseFloat(progress.woodSec) - 1.125) < 0.15, progress.woodSec + 's');

// ---- D 高 tier 矿石门槛 ----
const tiers = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/items.js');
  const bmod = await import('/js/blocks.js');
  const t = (k) => mod.ITEM_BY_KEY[k].tool;
  return {
    ironWood: bmod.canHarvest(bmod.BLOCK_BY_KEY.iron_ore, t('wooden_pickaxe')),
    ironStone: bmod.canHarvest(bmod.BLOCK_BY_KEY.iron_ore, t('stone_pickaxe')),
    diaWood: bmod.canHarvest(bmod.BLOCK_BY_KEY.diamond_ore, t('wooden_pickaxe')),
    diaDiamond: bmod.canHarvest(bmod.BLOCK_BY_KEY.diamond_ore, t('diamond_pickaxe')),
    obsidianWood: bmod.canHarvest(bmod.BLOCK_BY_KEY.obsidian, t('wooden_pickaxe'))
  };
})()`);
check('木镐采不了铁矿石', tiers.ironWood === false);
check('石镐能采铁矿石', tiers.ironStone === true);
check('木镐采不了钻石矿', tiers.diaWood === false);
check('钻石镐能采钻石矿', tiers.diaDiamond === true);
check('木镐采不了黑曜石', tiers.obsidianWood === false);

// ---- E 耐久：挖一次掉 1 点 ----
const dur = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/items.js');
  const bmod = await import('/js/blocks.js');
  const IT = g.inventory;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z) - 3;
  g.world.setBlock(bx, by, bz, bmod.BLOCK_BY_KEY.stone.id);
  IT.slots[0] = { id: mod.ITEM_BY_KEY.wooden_pickaxe.id, count: 1, dmg: 0 };
  IT.selected = 0;
  g.breakBlock(bx, by, bz);
  const after = IT.slots[0] ? IT.slots[0].dmg : -1;
  IT.slots[0] = null;
  g.dropped.clear();
  return { after, max: mod.ITEM_BY_KEY.wooden_pickaxe.tool.durability };
})()`);
check('挖一次消耗 1 点耐久', dur.after === 1, `dmg=${dur.after} / max=${dur.max}`);

// ---- F 跑一段真实帧，确认不报错、帧率正常 ----
await ev(`(function(){ const g = window.game; g.survival.reset(); g.mobs.clear(); return true; })()`);
await sleep(3000);
const perf = await ev(`(function(){ const g = window.game; return { fps: g.fps }; })()`);
check('跑 3 秒后帧率 > 20', perf.fps > 20, 'fps=' + perf.fps);
check('运行期无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

// ---- G 按住右键连续放置：只对方块生效，松手立刻停 ----
const holdRight = await ev(`(async function(){
  const g = window.game;
  const items = await import('/js/items.js');
  const inv = g.inventory;
  inv.slots[0] = { id: items.ITEM_BY_KEY['cobblestone'].id, count: 64, dmg: 0 };
  inv.selected = 0;
  g.locked = true;
  let calls = 0;
  const orig = g.useItem;
  g.useItem = function(){ calls++; };
  g.canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button: 2 }));
  await new Promise((r) => setTimeout(r, 800));
  const during = calls;
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, button: 2 }));
  await new Promise((r) => setTimeout(r, 500));
  const afterRelease = calls;
  g.useItem = orig;
  inv.slots[0] = null;
  inv.selected = 0;
  g.locked = document.pointerLockElement === g.canvas;
  return { during, afterRelease };
})()`);
check('按住右键会连续放置（800ms 内 >= 3 次）', holdRight.during >= 3, JSON.stringify(holdRight));
check('松开右键立刻停手', holdRight.afterRelease === holdRight.during, JSON.stringify(holdRight));

// ---- H 准星选中框：站着不挖也要显示 ----
// 原来 highlight.visible = true 只写在 updateMining 里，而 updateMining 一进来就
// 「没按左键就 return」，结果整个游戏只有按住左键那一刻才看得见方块轮廓。
const targetBox = await ev(`(async function(){
  const g = window.game;
  const B = (await import('/js/blocks.js')).BLOCK_BY_KEY;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z) - 3;
  g.world.setBlock(bx, by, bz, B.stone.id);
  const eye = g.player.eyePos();
  const dx = bx + 0.5 - eye.x, dy = by + 0.5 - eye.y, dz = bz + 0.5 - eye.z;
  g.player.yaw = Math.atan2(-dx, -dz);
  g.player.targetYaw = g.player.yaw;
  g.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  g.player.targetPitch = g.player.pitch;
  g.ui.close();
  g.mining = false;

  g.updateTarget(true);
  const hit = g.hitTest();
  const idle = { visible: g.highlight.visible,
                 pos: [g.highlight.position.x, g.highlight.position.y, g.highlight.position.z] };
  // 「不能操作」时（界面开着 / 死了 / 睡觉）要收起来
  g.updateTarget(false);
  const gated = g.highlight.visible;
  g.updateTarget(true);
  const back = g.highlight.visible;
  // 打生物那条分支会调 hideMineOverlay，不能顺手把选中框抹掉
  g.hideMineOverlay();
  const afterHideOverlay = g.highlight.visible;
  // 单独调 updateMining（测试/老调用方）也要能挖
  g.mineState = null;
  let f = 0;
  g.mining = true;
  for (; f < 3000; f++) { g.updateMining(0.016); if (g.world.getBlock(bx, by, bz) === 0) break; }
  g.mining = false;
  g.mineState = null;
  g.world.setBlock(bx, by, bz, 0);
  return { idle, gated, back, afterHideOverlay, hit: hit ? [hit.x, hit.y, hit.z] : null, broke: f, expect: [bx, by, bz] };
})()`);
check('站着不按左键：准星选中框也显示', targetBox.idle.visible === true, JSON.stringify(targetBox.idle));
check('选中框位置 = 准星命中的方块中心',
  targetBox.hit && JSON.stringify(targetBox.idle.pos) === JSON.stringify(targetBox.hit.map((v) => v + 0.5)),
  JSON.stringify(targetBox));
check('界面开着时收起选中框', targetBox.gated === false && targetBox.back === true, JSON.stringify(targetBox));
check('hideMineOverlay 不再抹掉选中框', targetBox.afterHideOverlay === true, JSON.stringify(targetBox));
check('单独调 updateMining 仍能挖穿方块', targetBox.broke > 0 && targetBox.broke < 3000, 'f=' + targetBox.broke);

console.log('\n================ 挖掘/掉落验证 ================');
let pass = 0;
for (const r of results) {
  console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  if (r.ok) pass++;
}
console.log('----------------------------------------------');
console.log('通过 ' + pass + '/' + results.length);
if (cdp.errors.length) {
  console.log('\nJS 报错:');
  for (const e of cdp.errors.slice(0, 10)) console.log('  ' + e);
}
chrome.kill();
process.exit(pass === results.length ? 0 : 1);
