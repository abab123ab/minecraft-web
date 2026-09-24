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

// ---- K 生物渲染贴合 hitbox + 朝向用自身 yaw ----
//
// 生物从「一张永远正对相机的贴纸」换成了「一堆长方体拼的 3D 模型」，
// 所以量的是整个网格的世界包围盒，而不是某个 plane 的 geometry.parameters。
const sizes = await ev(`(async function(){
  const THREE = await import('/js/vendor/three.module.js');
  const g = window.game;
  g.mobs.clear();
  g.mobs.spawnTimer = 999;
  const p = g.player.pos;
  const out = {};
  const types = ['pig', 'cow', 'chicken', 'sheep', 'zombie', 'skeleton', 'creeper'];
  types.forEach((t, i) => {
    // 一次性摆到高处远处，别让它们影响后面几个用例；量完就清掉
    const m = g.mobs.spawn(t, p.x + 40, p.y + 40, p.z + 40 + i * 3);
    const bb = new THREE.Box3().setFromObject(m.mesh);
    let parts = 0, tris = 0;
    m.mesh.traverse((o) => {
      if (!o.isMesh) return;
      parts++;
      const idx = o.geometry.getIndex();
      tris += idx ? idx.count / 3 : 0;
    });
    out[t] = {
      h: +(bb.max.y - bb.min.y).toFixed(3),
      w: +(bb.max.x - bb.min.x).toFixed(3),
      d: +(bb.max.z - bb.min.z).toFixed(3),
      // 相对生物自己的脚下，不是世界坐标 —— 生物是生成在 p.y+40 的
      minY: +(bb.min.y - m.pos.y).toFixed(4),
      hitbox: { h: m.def.h, w: m.def.w },
      parts, tris
    };
  });
  g.mobs.clear();
  return out;
})()`);
for (const t of Object.keys(sizes)) {
  const s = sizes[t];
  check(t + ' 渲染高 ≈ hitbox 高（误差<0.01）', Math.abs(s.h - s.hitbox.h) < 0.01, JSON.stringify(s));
  check(t + ' 脚踩在自己脚下（相对 y=0）', Math.abs(s.minY) < 0.01, 'minY=' + s.minY);
  check(t + ' 是多个长方体拼的（不是一张平面）', s.parts >= 6 && s.tris >= 70, JSON.stringify({ parts: s.parts, tris: s.tris }));
}

// 朝向必须是生物自己走的那个方向，不能再永远正对相机
// （以前是一张纸片，只有正对相机才「看起来像」；现在的模型必须有自己的朝向）
const facing = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.mobs.spawnTimer = 999;
  const p = g.player.pos;
  const pig = g.mobs.spawn('pig', p.x, p.y, p.z - 4);
  pig.pauseTimer = 0;
  pig.wanderTimer = 999;
  pig.yaw = 0.5;
  pig.vel.x = 0;
  pig.vel.z = 0;
  for (let i = 0; i < 3; i++) g.updateMobs(0.016);
  const r = {
    yaw: pig.yaw,
    rotY: pig.mesh.rotation.y,
    toCam: Math.atan2(g.camera.position.x - pig.pos.x, g.camera.position.z - pig.pos.z),
    legsA: pig.mesh.userData.legs.length,
    legsB: pig.mesh.userData.legsB.length
  };
  g.mobs.clear();
  return r;
})()`);
check('朝向跟着自己的 yaw（不再永远正对相机）', Math.abs(facing.rotY - facing.yaw) < 1e-6,
  JSON.stringify(facing));
check('这一条不是空跑（yaw 和「对着相机」确实不同）', Math.abs(facing.yaw - facing.toCam) > 0.1,
  JSON.stringify(facing));
check('四足生物挂上了两组对角腿', facing.legsA === 2 && facing.legsB === 2,
  facing.legsA + '/' + facing.legsB);

// ---- L 走路动画：移动时上下浮动 ----
//
// 两条坑：
// 1) think() 每帧按 yaw 重写 vel，塞 vel.x 没用，得把 yaw 摆成 sin≠0；
// 2) 生物脚下那一列不一定是平的。生物是钉在 p.y 的，p.x+3 那列地面矮一格的话
//    它就永远悬空、onGround 一直 false，gait 恒为 0。
//    而「不走路」时 update() 会额外叠一个 ±0.03 的闲置呼吸，
//    所以只看 bob>0.005 会拿呼吸当成走路 bob 通过。这里改成先探地形把猪放到实地面上。
const walkAnim = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.mobs.spawnTimer = 999;
  const p = g.player.pos;
  const bx = Math.floor(p.x) + 3, bz = Math.floor(p.z);
  const by = Math.floor(p.y);
  // 清一块空地，别让它撞墙
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = 0; dy <= 5; dy++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  // 探这一列的地面：从上往下找第一块实心，站它上面
  let gy = by + 6;
  while (gy > 0 && g.world.getBlock(bx, gy, bz) === 0) gy--;
  const stand = gy + 1;
  const pig = g.mobs.spawn('pig', bx + 0.5, stand, bz + 0.5);
  let maxBob = 0, maxAmp = 0;
  for (let i = 0; i < 120; i++) {
    pig.pos.x = bx + 0.5;
    pig.pos.z = bz + 0.5;
    pig.pos.y = stand;
    pig.pauseTimer = 0;
    pig.wanderTimer = 999;
    pig.panic = 0;
    pig.yaw = Math.PI / 2;   // sin=1，think() 才会给它速度
    g.updateMobs(0.016);
    maxBob = Math.max(maxBob, Math.abs(pig.mesh.position.y - pig.pos.y));
    maxAmp = Math.max(maxAmp, pig.walkAmp);
  }
  // 对照：站着不动时 walkAmp 必须掉下去，bob 只剩闲置呼吸那点
  // 先跑 60 帧让它衰减干净，再看剩下的摆动
  for (let i = 0; i < 60; i++) {
    pig.pos.y = stand;
    pig.pauseTimer = 999;
    g.updateMobs(0.016);
  }
  let idleBob = 0;
  for (let i = 0; i < 60; i++) {
    pig.pos.y = stand;
    pig.pauseTimer = 999;
    g.updateMobs(0.016);
    idleBob = Math.max(idleBob, Math.abs(pig.mesh.position.y - pig.pos.y));
  }
  const idleAmp = pig.walkAmp;
  g.mobs.clear();
  return { maxBob, maxAmp, idleBob, idleAmp, onGroundLast: pig.onGround };
})()`);
check('走动时垂直 bob > 0.02', walkAnim.maxBob > 0.02, JSON.stringify(walkAnim));
check('走动时 walkAmp 抬起来（> 0.02）', walkAnim.maxAmp > 0.02, JSON.stringify(walkAnim));
// 这一条对着上面的：不动的时候 walkAmp 要落回 0，bob 只剩呼吸的 ±0.03
check('站着不动时 walkAmp 落回 0（bob 确实来自走路）', walkAnim.idleAmp < 0.005,
  JSON.stringify(walkAnim));

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
    frames.push({ rot: pig.mesh.rotation.z, op: pig.mesh.userData.mats[0].opacity });
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
  const snap = () => { const m = c.mesh.userData.mats[0].color; return { sx: c.mesh.scale.x, r: m.r, g: m.g, b: m.b }; };
  const before = snap();
  for (let i = 0; i < 6; i++) { g.updateMobs(0.03); if (!g.mobs.list.includes(c)) break; }
  const during = snap();
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

// ---- P 挨打闪红：红通道不动，绿蓝压下去 ----
//
// 以前三个通道乘的是同一个系数，量出来整只只是发灰、并没变红。
const hurtTint = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.mobs.spawnTimer = 999;
  const p = g.player.pos;
  const pig = g.mobs.spawn('pig', p.x + 3, p.y, p.z);
  const snap = () => { const m = pig.mesh.userData.mats[0].color; return { r: +m.r.toFixed(4), g: +m.g.toFixed(4), b: +m.b.toFixed(4) }; };
  for (let i = 0; i < 2; i++) g.updateMobs(0.016);
  const calm = snap();
  pig.hurtFlash = 0.4;
  g.updateMobs(0.016);
  const hit = snap();
  g.mobs.clear();
  return { calm, hit };
})()`);
check('挨打时红通道不动、绿蓝压下去（才是「闪红」不是「发灰」）',
  hurtTint.hit.r >= hurtTint.calm.r - 1e-6 &&
  hurtTint.hit.g < hurtTint.calm.g - 0.1 &&
  hurtTint.hit.b < hurtTint.calm.b - 0.1,
  JSON.stringify(hurtTint));

// ---- Q 走路时腿真的在前后摆 ----
//
// 只量 mesh.position.y 的 bob 是不够的：那是整只上下晃，
// 摆腿有没有落到每条腿上、是不是绕对了轴，得看腿块自己的 rotation.x。
//
// 注意两件事：
// 1) think() 每一帧都会按 yaw 重写 vel（m.vel.x = sin(yaw) * speed * 0.55），
//    在外面直接塞 vel.x 是没用的 —— yaw=0 就得到 sin(0)=0，摆幅量出来是 0，
//    所以把 yaw 固定成正朝 +x（sin=1），让它自己走出速度来。
// 2) 还得先探脚下那一列的地面再把它放上去，否则它一直悬空、onGround=false，
//    gait 恒为 0，照样摆不起来。
const legSwing = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.mobs.spawnTimer = 999;
  const p = g.player.pos;
  const px = Math.floor(p.x) + 5, pz = Math.floor(p.z);
  let gy = Math.floor(p.y) + 6;
  while (gy > 0 && g.world.getBlock(px, gy, pz) === 0) gy--;
  const stand = gy + 1;
  const pig = g.mobs.spawn('pig', px + 0.5, stand, pz + 0.5);
  let maxA = 0, maxB = 0, crossZ = 0, antiPhase = 0;
  for (let i = 0; i < 120; i++) {
    // 钉住位置，让它一直保持「在走」的状态，别飘远、别撞墙
    pig.pos.x = px + 0.5;
    pig.pos.z = pz + 0.5;
    pig.pos.y = stand;
    pig.pauseTimer = 0;
    pig.wanderTimer = 999;
    pig.panic = 0;
    pig.yaw = Math.PI / 2;
    g.updateMobs(0.016);
    const a = pig.mesh.userData.legs[0].rotation.x;
    const b = pig.mesh.userData.legsB[0].rotation.x;
    for (const pg of pig.mesh.userData.legs) {
      maxA = Math.max(maxA, Math.abs(pg.rotation.x));
      // 绕 z 轴转就是左右撇腿，那是不对的
      crossZ = Math.max(crossZ, Math.abs(pg.rotation.z));
    }
    for (const pg of pig.mesh.userData.legsB) maxB = Math.max(maxB, Math.abs(pg.rotation.x));
    // 两组腿要一直反相：加起来应该恒为 0。整段取最大值才有意义，
    // 只看最后一帧的话两只都是 0 也会「通过」。
    antiPhase = Math.max(antiPhase, Math.abs(a + b));
  }
  g.mobs.clear();
  return {
    maxA: +maxA.toFixed(3), maxB: +maxB.toFixed(3), crossZ, antiPhase: +antiPhase.toFixed(6),
    onGround: pig.onGround, stand: stand
  };
})()`);
check('走路时腿绕 x 轴前后摆（摆幅 ' + legSwing.maxA + '）', legSwing.maxA > 0.25 && legSwing.maxB > 0.25,
  JSON.stringify(legSwing));
check('对角线两组腿全程反相（同一时刻一前一后）', legSwing.antiPhase < 1e-6, JSON.stringify(legSwing));
check('腿没有左右撇（rotation.z 一直是 0）', legSwing.crossZ < 1e-6, String(legSwing.crossZ));

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
