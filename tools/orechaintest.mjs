import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-orechain-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--window-size=1024,640',
  '--user-data-dir=' + userDir
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('devtools 未启动');
}

const version = await waitForDevtools();

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.session = null;
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
        return;
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
const targetId = created.result.targetId;
const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
cdp.session = attached.result.sessionId;

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: APP });
await sleep(2500);

async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.result && r.result.exceptionDetails) {
    throw new Error('evaluate 失败: ' + JSON.stringify(r.result.exceptionDetails));
  }
  return r.result.result.value;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });
}

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

// ---- A 新矿石与掉落物定义 ----
const oreDefs = await ev(`(async function(){
  const blocks = await import('/js/blocks.js');
  const items = await import('/js/items.js');
  const craft = await import('/js/crafting.js');
  const out = {};
  for (const k of ['copper_ore','redstone_ore','lapis_ore','emerald_ore']) {
    const b = blocks.BLOCK_BY_KEY[k];
    out[k] = { ore: b.ore, tier: b.tier, requiresTool: b.requiresTool, drop: b.drop };
  }
  for (const k of ['copper_ingot','redstone','lapis_lazuli','emerald']) {
    out[k] = { item: !!items.ITEM_BY_KEY[k] };
  }
  const copperOreId = items.ITEM_BY_KEY['copper_ore'].id;
  const copperIngotId = items.ITEM_BY_KEY['copper_ingot'].id;
  out.copperSmelt = craft.SMELTING.some((s) => s.input === copperOreId && s.output === copperIngotId);
  return out;
})()`);
check('铜/红石/青金/绿宝石矿石 ore 标记为 true', oreDefs.copper_ore.ore && oreDefs.redstone_ore.ore && oreDefs.lapis_ore.ore && oreDefs.emerald_ore.ore, JSON.stringify(oreDefs));
check('新矿石有正确 tier', oreDefs.copper_ore.tier === 1 && oreDefs.redstone_ore.tier === 2 && oreDefs.lapis_ore.tier === 2 && oreDefs.emerald_ore.tier === 2, JSON.stringify(oreDefs));
check('新掉落物已注册', oreDefs.copper_ingot.item && oreDefs.redstone.item && oreDefs.lapis_lazuli.item && oreDefs.emerald.item);
check('铜矿石可烧炼为铜锭', oreDefs.copperSmelt);

// ---- B 世界生成包含新矿石 ----
const gen = await ev(`(async function(){
  const g = window.game;
  const blocks = await import('/js/blocks.js');
  const counts = { coal_ore:0, copper_ore:0, iron_ore:0, gold_ore:0, redstone_ore:0, lapis_ore:0, emerald_ore:0, diamond_ore:0, total:0 };
  const byY = {};
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const ch = g.world.getChunk(cx, cz);
      if (!ch) continue;
      for (let i = 0; i < ch.data.length; i++) {
        const id = ch.data[i];
        const b = blocks.BLOCKS[id];
        if (b && counts[b.key] !== undefined) {
          counts[b.key]++;
          counts.total++;
          const y = (i / (16 * 16)) | 0;
          byY[y] = byY[y] || {};
          byY[y][b.key] = (byY[y][b.key] || 0) + 1;
        }
      }
    }
  }
  return { counts, byY };
})()`);
// 绿宝石是山地专属矿（worldgen 里靠 biome == 'mountains' 卡），出生点附近基本不是山地，
// 所以这里只验不挑群系的那三种。绿宝石在山地里的产量由 oredist.mjs 第七节单独负责。
check('生成中至少存在 3 种新矿石（铜/红石/青金石）', ['copper_ore','redstone_ore','lapis_ore'].filter((k) => gen.counts[k] > 0).length >= 3, JSON.stringify(gen.counts));
check('深层有钻石/红石（y<=15）', (gen.byY[15] && (gen.byY[15].diamond_ore || 0) + (gen.byY[15].redstone_ore || 0) > 0) || (gen.byY[10] && (gen.byY[10].diamond_ore || 0) + (gen.byY[10].redstone_ore || 0) > 0), JSON.stringify(gen.byY[10] || gen.byY[15]));

// ---- C 连锁挖矿：挖一块连着的煤矿会清掉相邻矿脉 ----
const chain = await ev(`(async function(){
  const g = window.game;
  const items = await import('/js/items.js');
  const blocks = await import('/js/blocks.js');
  const coalId = blocks.BLOCK_BY_KEY['coal_ore'].id;
  const pickId = items.ITEM_BY_KEY['diamond_pickaxe'].id;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  // clear a small area in front
  for (let dx = -2; dx <= 3; dx++)
    for (let dy = -1; dy <= 3; dy++)
      for (let dz = 2; dz <= 6; dz++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  // place a 2x2x2 coal vein
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        g.world.setBlock(bx + dx, by + dy, bz + 3 + dz, coalId);
  const before = g.world.getBlock(bx, by, bz + 3);
  const oreBefore = [before];
  let connectedBefore = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        if (g.world.getBlock(bx + dx, by + dy, bz + 3 + dz) === coalId) connectedBefore++;
  g.dropped.clear();
  g.inventory.slots[0] = { id: pickId, count: 1, dmg: 0 };
  g.inventory.selected = 0;
  g.breakBlock(bx, by, bz + 3);
  let broken = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        if (g.world.getBlock(bx + dx, by + dy, bz + 3 + dz) === 0) broken++;
  const drops = g.dropped.list.length;
  g.inventory.slots[0] = null;
  return { before, connectedBefore, broken, drops };
})()`);
check('连锁挖矿：2x2x2 煤矿被挖掉多数', chain.broken >= 6, JSON.stringify(chain));
check('连锁挖矿产生多个掉落', chain.drops >= 6, JSON.stringify(chain));

// ---- C2 真实世界回归：自然生成的矿石必须能连锁（抓“没有连锁”的线上 bug）----
// 旧实现用 6 邻接 BFS + 自然单块矿石 → 挖一块只掉一块。这里直接验证生成后的矿石
// 在 7x7x7 半径内确实连成了矿脉（>=3 块），否则连锁在真实游戏里体感为“没有连锁”。
const naturalChain = await ev(`(async function(){
  const g = window.game;
  const blocks = await import('/js/blocks.js');
  const ORE_KEYS = ['coal_ore','copper_ore','iron_ore','gold_ore','redstone_ore','lapis_ore','emerald_ore','diamond_ore'];
  const ORE_IDS = new Set(ORE_KEYS.map((k) => blocks.BLOCK_BY_KEY[k].id));
  let best = { found: false, maxVein: 0 };
  let totalOres = 0;
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const ch = g.world.getChunk(cx, cz);
      if (!ch) continue;
      for (let i = 0; i < ch.data.length; i++) {
        const id = ch.data[i];
        if (!ORE_IDS.has(id)) continue;
        totalOres++;
        const lx = i % 16, lz = ((i / 16) | 0) % 16;
        if (lx < 4 || lx > 11 || lz < 4 || lz > 11) continue;
        const y = (i / (16 * 16)) | 0;
        const wx = cx * 16 + lx, wz = cz * 16 + lz;
        const vein = g.collectOreVein(wx, y, wz, id, 48);
        if (vein.length > best.maxVein) best = { found: true, maxVein: vein.length, key: blocks.BLOCKS[id].key };
      }
    }
  }
  return { found: best.found, maxVein: best.maxVein, totalOres };
})()`);
check('自然矿石存在可连锁矿脉（半径内>=3 块）', naturalChain.found && naturalChain.maxVein >= 3, JSON.stringify(naturalChain));

// ---- C3 连锁不受“是否拿对工具”影响：空手挖矿也清掉整条矿脉（只不掉物）----
const chainNoTool = await ev(`(async function(){
  const g = window.game;
  const blocks = await import('/js/blocks.js');
  const coalId = blocks.BLOCK_BY_KEY['coal_ore'].id;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  for (let dx = -2; dx <= 3; dx++)
    for (let dy = -1; dy <= 3; dy++)
      for (let dz = 2; dz <= 6; dz++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        g.world.setBlock(bx + dx, by + dy, bz + 3 + dz, coalId);
  g.dropped.clear();
  g.inventory.slots[0] = null;
  g.inventory.selected = 0;
  g.breakBlock(bx, by, bz + 3);
  let broken = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        if (g.world.getBlock(bx + dx, by + dy, bz + 3 + dz) === 0) broken++;
  const drops = g.dropped.list.length;
  return { broken, drops };
})()`);
check('空手也能连锁清掉整条矿脉（只不掉物）', chainNoTool.broken >= 6 && chainNoTool.drops === 0, JSON.stringify(chainNoTool));

// ---- C4 只连锁“相连”的矿脉：隔壁一条不相连的矿脉不能被误清 ----
// 用连通分量 BFS：矿脉 A 与矿脉 B 之间隔 1 格石头（不相连），但 B 在被挖块 3 格半径内。
// 旧半径扫描会把 B 一起挖掉（误清），正确逻辑应只清 A。
const connectedOnly = await ev(`(async function(){
  const g = window.game;
  const blocks = await import('/js/blocks.js');
  const items = await import('/js/items.js');
  const coalId = blocks.BLOCK_BY_KEY['coal_ore'].id;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  for (let dx = -2; dx <= 3; dx++)
    for (let dy = -1; dy <= 3; dy++)
      for (let dz = 2; dz <= 9; dz++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        g.world.setBlock(bx + dx, by + dy, bz + 3 + dz, coalId); // 矿脉 A
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        g.world.setBlock(bx + dx, by + dy, bz + 6 + dz, coalId); // 矿脉 B（隔 1 格石头）
  g.dropped.clear();
  g.inventory.slots[0] = { id: items.ITEM_BY_KEY['diamond_pickaxe'].id, count: 1, dmg: 0 };
  g.inventory.selected = 0;
  g.breakBlock(bx, by, bz + 3);
  let aLeft = 0, bLeft = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        if (g.world.getBlock(bx + dx, by + dy, bz + 3 + dz) === coalId) aLeft++;
        if (g.world.getBlock(bx + dx, by + dy, bz + 6 + dz) === coalId) bLeft++;
      }
  g.inventory.slots[0] = null;
  return { aLeft, bLeft };
})()`);
check('只连锁相连矿脉：A 清光、B 不误清', connectedOnly.aLeft === 0 && connectedOnly.bLeft === 8, JSON.stringify(connectedOnly));

// ---- D 非矿石不会连锁 ----
const noChain = await ev(`(async function(){
  const g = window.game;
  const blocks = await import('/js/blocks.js');
  const dirtId = blocks.BLOCK_BY_KEY['dirt'].id;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  // 3x3 dirt pad
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = 8; dz <= 10; dz++)
      g.world.setBlock(bx + dx, by - 1, bz + dz, dirtId);
  g.dropped.clear();
  g.breakBlock(bx, by - 1, bz + 9);
  let remaining = 0;
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = 8; dz <= 10; dz++)
      if (g.world.getBlock(bx + dx, by - 1, bz + dz) === dirtId) remaining++;
  return { remaining };
})()`);
check('泥土不会连锁', noChain.remaining === 8, JSON.stringify(noChain));

console.log('\n================ 矿石与连锁挖矿验证 ================');
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
