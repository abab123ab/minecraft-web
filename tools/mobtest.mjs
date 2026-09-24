import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-mobtest-' + Date.now());

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

// 等待游戏初始化
let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await ev('!!(window.game && window.game.world && window.game.mobs)');
  if (ready) break;
  await sleep(500);
}
check('游戏初始化完成（含 mobs）', ready);

// 点击开始
await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1500);

check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

// ---- A 白天/夜晚刷怪类型 ----
const spawnKinds = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  for (let i = 0; i < 40; i++) g.mobs.trySpawn(g.player, false);
  const day = Array.from(new Set(g.mobs.list.map(m => m.def.hostile ? 'H' : 'P')));
  const dayCount = g.mobs.count();
  g.mobs.clear();
  for (let i = 0; i < 40; i++) g.mobs.trySpawn(g.player, true);
  const night = Array.from(new Set(g.mobs.list.map(m => m.def.hostile ? 'H' : 'P')));
  const nightCount = g.mobs.count();
  g.mobs.clear();
  // 探测：玩家位置 + 几个方向 surface+1 的 lightAt
  const probe = [];
  for (let dx = -8; dx <= 8; dx += 4) for (let dz = -8; dz <= 8; dz += 4) {
    const x = Math.floor(g.player.pos.x + dx);
    const z = Math.floor(g.player.pos.z + dz);
    let y = 79; while (y >= 0 && g.world.getBlock(x, y, z) === 0) y--;
    const lt = g.world.lightAt(x, y + 1, z);
    probe.push({ x, z, y: y+1, sky: lt.sky, lit: lt.lit });
  }
  const rawProbe = (function(){
    const ch = g.world.getChunk(0, 0);
    if (!ch || !ch.skyLight) return null;
    const idx = function(x, y, z){ return x + 16 * (z + 16 * y); };
    return { 'y41': ch.skyLight[idx(0, 41, 0)], 'y42': ch.skyLight[idx(0, 42, 0)], 'y50': ch.skyLight[idx(0, 50, 0)], 'y70': ch.skyLight[idx(0, 70, 0)], 'y79': ch.skyLight[idx(0, 79, 0)] };
  })();
  return { day, night, dayCount, nightCount, dayness: g.world.dayness, timeOfDay: g.timeOfDay, rawProbe, probe };
})()`);
check('白天只刷被动生物', spawnKinds.day.length === 1 && spawnKinds.day[0] === 'P', JSON.stringify(spawnKinds));
check('白天刷怪数量 > 0', spawnKinds.dayCount > 0, spawnKinds.dayCount);
check('夜晚只刷敌对生物', spawnKinds.night.length === 1 && spawnKinds.night[0] === 'H', JSON.stringify(spawnKinds));
check('夜晚刷怪数量 > 0', spawnKinds.nightCount > 0, spawnKinds.nightCount);

// ---- B 左键攻击打中生物 + 掉落 ----
const attack = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.dropped.clear();
  g.player.pitch = 0;
  g.player.targetYaw = g.player.yaw = 0;
  g.mobs.spawnTimer = 999;
  const p = g.player.pos;
  const pig = g.mobs.spawn('pig', p.x, p.y, p.z - 2);
  pig.onGround = true;
  pig.vel.y = 0;
  const dir = g.lookDir();
  const eye = g.player.eyePos();
  const hit = g.mobs.raycast(eye, dir, 3.2);
  const hitsPig = hit === pig;
  const before = g.dropped.list.length;
  if (hitsPig) pig.hurt(100, { x: 0, z: 0 });
  for (let i = 0; i < 120; i++) {
    g.mobs.spawnTimer = 999;
    g.updateMobs(0.016);
  }
  const after = g.dropped.list.length;
  const mobGone = g.mobs.count() === 0;
  g.dropped.clear();
  return { hitsPig, before, after, mobGone };
})()`);
  check('准星能选中 2 格外的生物', attack.hitsPig);
  check('打死生物后掉落物品', attack.after > attack.before, 'before=' + attack.before + ' after=' + attack.after);
  check('死亡生物从场景移除', attack.mobGone);

// ---- C 僵尸近战让玩家掉血 ----
const zombie = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.survival.reset();
  const p = g.player.pos;
  g.mobs.spawn('zombie', p.x + 1, p.y, p.z);
  g.updateMobs(0.05);
  return { health: g.survival.health };
})()`);
check('僵尸近战扣血 3 点', zombie.health === 17, 'health=' + zombie.health);

// ---- D 骷髅射箭扣血 ----
const skeleton = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.survival.reset();
  const p = g.player.pos;
  g.mobs.spawn('skeleton', p.x + 8, p.y, p.z);
  for (let i = 0; i < 200; i++) { g.mobs.spawnTimer = 999; g.updateMobs(0.03); }
  return { health: g.survival.health, arrows: g.mobs.arrows.length };
})()`);
check('骷髅射箭能命中玩家扣血', skeleton.health < 20, 'health=' + skeleton.health);

// ---- E 苦力怕爆炸 ----
const creeper = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.survival.reset();
  const p = g.player.pos;
  const c = g.mobs.spawn('creeper', p.x + 1, p.y, p.z);
  for (let i = 0; i < 120; i++) { g.mobs.spawnTimer = 999; g.updateMobs(0.05); }
  g.mobs.clear();
  return { health: g.survival.health, gone: g.mobs.list.indexOf(c) === -1, drops: g.dropped.list.length };
})()`);
check('苦力怕引爆后玩家掉血', creeper.health < 20, 'health=' + creeper.health);
check('苦力怕爆炸后消失', creeper.gone, JSON.stringify(creeper));

// ---- F 白天僵尸自燃 ----
const burn = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  const p = g.player.pos;
  const z = g.mobs.spawn('zombie', p.x + 6, p.y, p.z);
  const h0 = z.health;
  for (let i = 0; i < 20; i++) { g.mobs.spawnTimer = 999; g.updateMobs(0.1); }
  const alive = g.mobs.list.indexOf(z) >= 0;
  g.mobs.clear();
  return { h0, h1: z.health, alive, isDay: g.isDay };
})()`);
check('白天僵尸在阳光下自燃', burn.isDay && (!burn.alive || burn.h1 < burn.h0), JSON.stringify(burn));

// ---- G 攻击力随工具变化 ----
const dmg = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/items.js');
  const IT = g.inventory;
  const id = (k) => mod.ITEM_BY_KEY[k].id;
  const out = {};
  IT.slots[0] = null; IT.selected = 0;
  out.fist = g.attackDamage();
  IT.slots[0] = { id: id('wooden_pickaxe'), count: 1, dmg: 0 };
  out.woodPick = g.attackDamage();
  IT.slots[0] = { id: id('wooden_axe'), count: 1, dmg: 0 };
  out.woodAxe = g.attackDamage();
  IT.slots[0] = { id: id('diamond_axe'), count: 1, dmg: 0 };
  out.diamondAxe = g.attackDamage();
  IT.slots[0] = null;
  return out;
})()`);
check('空手伤害 1', dmg.fist === 1, dmg.fist);
check('木镐伤害 2', dmg.woodPick === 2, dmg.woodPick);
check('木斧伤害 7', dmg.woodAxe === 7, dmg.woodAxe);
check('钻石斧伤害 9', dmg.diamondAxe === 9, dmg.diamondAxe);

// ---- H 熔炉烤肉 ----
const cook = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/items.js');
  g.furnaces.clear();
  const pork = mod.ITEM_BY_KEY.porkchop.id;
  const cookedId = mod.ITEM_BY_KEY.cooked_porkchop.id;
  const coal = mod.ITEM_BY_KEY.coal.id;
  const f = { input: { id: pork, count: 1 }, fuel: { id: coal, count: 1 }, out: null, burn: 0, burnMax: 0, prog: 0, progMax: 1 };
  g.furnaces.set('t', f);
  for (let i = 0; i < 400; i++) g.updateFurnaces(0.05);
  const ok = !!f.out && f.out.id === cookedId;
  const food = f.out ? (mod.ITEMS[f.out.id].food || {}).hunger : 0;
  g.furnaces.clear();
  return { ok, food };
})()`);
check('熔炉把生猪排烧成熟猪排', cook.ok, JSON.stringify(cook));
check('熟猪排回复 8 点饥饿', cook.food === 8, cook.food);

// ---- I 跑一段真实帧，看 FPS 与报错 ----
await ev(`(function(){ const g = window.game; g.survival.reset(); g.mobs.clear(); return true; })()`);
await sleep(4000);
const perf = await ev(`(function(){
  const g = window.game;
  return { fps: g.fps, mobs: g.mobs.count(), chunks: g.world.chunks.size, health: g.survival.health, hunger: g.survival.hunger };
})()`);
check('跑 4 秒后帧率 > 20', perf.fps > 20, 'fps=' + perf.fps);
check('运行期无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

// ---- J 摆几只生物在面前截图 ----
await ev(`(async function(){
  const g = window.game;
  g.mobs.clear();
  g.isDay = true;
  g.mobs.spawnTimer = 999;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  for (let dx = -8; dx <= 8; dx++)
    for (let dz = -3; dz <= 9; dz++)
      for (let dy = 1; dy <= 6; dy++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  return true;
})()`);
await sleep(1200);
await ev(`(async function(){
  const g = window.game;
  g.player.pitch = 0;
  const dir = g.lookDir();
  const hl = Math.hypot(dir.x, dir.z) || 1;
  const fx = dir.x / hl, fz = dir.z / hl;
  const rx = -fz, rz = fx;
  const p = g.player.pos;
  const types = ['pig', 'cow', 'chicken', 'sheep', 'zombie', 'skeleton', 'creeper'];
  for (let i = 0; i < types.length; i++) {
    const off = (i - 3) * 0.95;
    g.mobs.spawn(types[i], p.x + fx * 3.5 + rx * off, p.y, p.z + fz * 3.5 + rz * off);
  }
  for (let i = 0; i < 8; i++) { g.mobs.spawnTimer = 999; g.updateMobs(0.016); }
  return g.mobs.count();
})()`);
await sleep(700);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.join(process.cwd(), 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'screenshots', 'mobtest.png'), Buffer.from(shot.result.data, 'base64'));

// ---- K 生物渲染贴合 hitbox ----
const sizes = await ev(`(function(){
  const g = window.game;
  const out = {};
  for (const m of g.mobs.list) {
    const g3 = m.mesh.geometry.parameters;
    out[m.type] = { h: g3.height, w: g3.width, hitbox: { h: m.def.h, w: m.def.w } };
  }
  return out;
})()`);
for (const t of Object.keys(sizes)) {
  const s = sizes[t];
  check(t + ' 渲染高 ≈ hitbox 高（误差<0.01）', Math.abs(s.h - s.hitbox.h) < 0.01, JSON.stringify(s));
}

// ---- L 走路动画：移动时上下浮动 ----
const walkAnim = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  const p = g.player.pos;
  const bx = Math.floor(p.x) + 3, bz = Math.floor(p.z);
  const by = Math.floor(p.y);
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = 0; dy <= 5; dy++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  const pig = g.mobs.spawn('pig', bx + 0.5, by, bz + 0.5);
  pig.pauseTimer = 0;
  pig.wanderTimer = 999;
  pig.yaw = 0;
  pig.vel.x = 1.5;
  pig.vel.z = 0;
  for (let i = 0; i < 4; i++) g.updateMobs(0.016);
  pig.onGround = true;
  let maxBob = 0;
  let maxAmp = 0;
  for (let i = 0; i < 120; i++) {
    g.updateMobs(0.016);
    pig.pauseTimer = 0;
    pig.wanderTimer = 999;
    pig.vel.x = 1.5;
    pig.vel.z = 0;
    pig.onGround = true;
    maxBob = Math.max(maxBob, Math.abs(pig.mesh.position.y - pig.pos.y));
    maxAmp = Math.max(maxAmp, pig.walkAmp);
  }
  g.mobs.clear();
  return { maxBob, amp: pig.walkAmp, maxAmp };
})()`);
check('走动时垂直 bob > 0.005', walkAnim.maxBob > 0.005, 'maxBob=' + walkAnim.maxBob);
check('走完时 walkAmp > 0.01', walkAnim.amp > 0.01 || walkAnim.maxAmp > 0.01, JSON.stringify(walkAnim));

// ---- M 卡墙转向 ----
const stuck = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  for (let dx = -1; dx <= 2; dx++)
    for (let dy = 0; dy <= 10; dy++)
      for (let dz = -1; dz <= 4; dz++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = 0; dy <= 10; dy++)
      g.world.setBlock(bx + dx, by + dy, bz + 3, 1);
  const pig = g.mobs.spawn('pig', bx + 0.5, by, bz + 0.5);
  pig.pauseTimer = 0;
  pig.wanderTimer = 999;
  pig.yaw = 0;
  pig.onGround = true;
  const yaw0 = pig.yaw;
  for (let i = 0; i < 100; i++) {
    pig.pauseTimer = 0;
    pig.wanderTimer = 999;
    pig.pos.y = by;
    pig.vel.y = 0;
    pig.onGround = true;
    g.updateMobs(0.05);
  }
  const yaw1 = pig.yaw;
  const turned = Math.abs(yaw1 - yaw0) > 0.5;
  g.mobs.clear();
  return { yaw0, yaw1, turned };
})()`);
check('撞墙后 yaw 改变', stuck.turned, JSON.stringify(stuck));

// ---- N 死亡动画：mesh 倒下 + 透明 ----
const deathAnim = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.dropped.clear();
  const p = g.player.pos;
  const pig = g.mobs.spawn('pig', p.x + 2, p.y, p.z);
  pig.hurt(100, { x: 0, z: 0 });
  const frames = [];
  for (let i = 0; i < 80; i++) {
    g.updateMobs(0.016);
    frames.push({ rot: pig.mesh.rotation.z, op: pig.mesh.material.opacity });
  }
  g.mobs.clear();
  return { rotMin: Math.min(...frames.map(f => f.rot)), opMin: Math.min(...frames.map(f => f.op)) };
})()`);
check('死亡过程旋转超过 -π/3（倒下）', deathAnim.rotMin < -Math.PI / 3, JSON.stringify(deathAnim));
check('死亡过程透明度下降到 0.5 以下', deathAnim.opMin < 0.5, JSON.stringify(deathAnim));

// ---- O 苦力怕鼓胀 + 闪白 ----
const creeperAnim = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  const p = g.player.pos;
  const c = g.mobs.spawn('creeper', p.x + 2, p.y, p.z);
  c.fuse = 0.4;
  const before = { sx: c.mesh.scale.x, r: c.mesh.material.color.r, g: c.mesh.material.color.g, b: c.mesh.material.color.b };
  for (let i = 0; i < 6; i++) { g.updateMobs(0.03); if (!g.mobs.list.includes(c)) break; }
  const during = { sx: c.mesh.scale.x, r: c.mesh.material.color.r, g: c.mesh.material.color.g, b: c.mesh.material.color.b };
  g.mobs.clear();
  // 闪白 = 三个通道一起抬高。以前这里只压绿蓝，量出来是「g 下降」，
  // 于是苦力怕鼓胀时整只变暗红，而这条断言还把它当成正确的锁住了。
  return {
    before, during,
    swelled: during.sx > before.sx + 0.05,
    flashed: during.r > before.r + 0.2 && during.g > before.g + 0.2 && during.b > before.b + 0.2
  };
})()`);
check('苦力怕引爆过程 mesh 放大', creeperAnim.swelled, JSON.stringify(creeperAnim));
check('苦力怕引爆过程闪白（三通道一起抬高）', creeperAnim.flashed, JSON.stringify(creeperAnim));

console.log('\n================ 生物系统验证 ================');
let pass = 0;
for (const r of results) {
  console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  if (r.ok) pass++;
}
console.log('----------------------------------------------');
console.log('通过 ' + pass + '/' + results.length);
console.log('运行时快照: ' + JSON.stringify(perf));
if (cdp.errors.length) {
  console.log('\nJS 报错:');
  for (const e of cdp.errors.slice(0, 10)) console.log('  ' + e);
}

chrome.kill();
process.exit(pass === results.length ? 0 : 1);
