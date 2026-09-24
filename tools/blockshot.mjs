// 出方块展示台那张图 screenshots/blocks.png。
//
//   node tools/blockshot.mjs [输出png] [方块key,方块key,...] [间距] [视角yaw]
//
// 铺一块平地，前排摆一排待检方块、后排砌一道石墙当背景，固定机位拍一张。
// 透明（玻璃/冰/水）、镂空（树叶/床）、朝向（熔炉炉门）这类问题在一张图里一次看全。
// 石墙是特意加的：不摆背景的话，透不透根本看不出来。
//
// 需要 serve.mjs 在 127.0.0.1:8321 上跑着。
//
// 四个坑：
// - 机位按「展示排中心 + 视线反方向退 dist」算，所以 yaw 改成多少，这一排都还在画面正中。
//   直接把相机放在排前方再改 yaw 的话，整排会滑到画面边上去。
// - 默认机位在 -z 侧（yaw=π）、石墙砌在 +z。熔炉的炉门开在 -z 面，站 +z 侧只能看到炉背。
// - 关主循环（started=false）之前必须先把玩家位置钉死 —— 关掉之后渲染还在跑。
// - 地面取这片区域最低的那一列再整体填平，不然方块会有一半陷进坡里。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9384;
const APP = 'http://127.0.0.1:8321/';
const OUT = process.argv[2] || path.join(process.cwd(), 'screenshots', 'blocks.png');
const KEYS = (process.argv[3] || 'stone,glass,ice,water,bed,furnace,leaves,spruce_leaves,torch,crafting_table,snow_block,wool').split(',');
const SPACING = process.argv[4] ? parseInt(process.argv[4], 10) : 1;
const YAW = process.argv[5] !== undefined ? parseFloat(process.argv[5]) : Math.PI;
const EYE_PITCH = -0.14;

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=1400,760', '--user-data-dir=' + path.join(os.tmpdir(), 'mc-bshot-' + Date.now())
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
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.session = null;
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
    this.ready = new Promise((r) => this.ws.addEventListener('open', r));
  }
  send(method, params) {
    const id = ++this.id;
    const p = { id, method, params: params || {} };
    if (this.session) p.sessionId = this.session;
    this.ws.send(JSON.stringify(p));
    return new Promise((r) => this.pending.set(id, r));
  }
}
const cdp = new Cdp(version.webSocketDebuggerUrl);
await cdp.ready;
const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
const at = await cdp.send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
cdp.session = at.result.sessionId;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: APP });
await sleep(2500);
async function ev(e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
for (let i = 0; i < 60; i++) { if (await ev('!!(window.game && window.game.mobs)')) break; await sleep(500); }
await ev(`document.getElementById('start-btn').click()`);
await sleep(2500);

const placed = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/blocks.js');
  const idOf = function(k){ const b = mod.BLOCKS.find(function(b){ return b.key === k; }); return b ? b.id : -1; };
  const keys = ${JSON.stringify(KEYS)};
  const ids = keys.map(idOf);
  g.mobs.clear();
  g.mobs.spawnTimer = 999;
  g.isDay = true;

  const p0 = g.player.pos;
  const bx0 = Math.floor(p0.x) + 4, bz0 = Math.floor(p0.z);
  const rowZ = bz0, wallZ = bz0 + 1;
  const n = keys.length;
  const SP = ${SPACING};
  const x0 = bx0, x1 = bx0 + (n - 1) * SP;
  const rowW = (n - 1) * SP;
  // 机位：把这一排框满画面为准。0.62 系数太保守 —— 12 个方块只占四成宽，
  // 下面还压着一大片空地面，方块本身小得看不清贴图。
  const dist = rowW * 0.38 + 2.5;
  const backZ = rowZ - Math.ceil(dist) - 2;

  let minY = 999;
  for (let x = x0 - 1; x <= x1 + 1; x++) {
    for (let z = backZ; z <= wallZ + 1; z++) {
      let y = 78; while (y > 0 && g.world.getBlock(x, y, z) === 0) y--;
      if (y < minY) minY = y;
    }
  }
  const stone = idOf('stone');
  const floor = minY;
  for (let x = x0 - 1; x <= x1 + 1; x++) {
    for (let z = backZ; z <= wallZ + 1; z++) {
      for (let dy = 1; dy <= 6; dy++) g.world.setBlock(x, floor + dy, z, 0);
      g.world.setBlock(x, floor, z, stone);
    }
  }
  for (let x = x0 - 1; x <= x1 + 1; x++) {
    g.world.setBlock(x, floor + 1, wallZ, stone);
    g.world.setBlock(x, floor + 2, wallZ, stone);
    g.world.setBlock(x, floor + 3, wallZ, stone);
  }
  for (let i = 0; i < n; i++) if (ids[i] >= 0) g.world.setBlock(x0 + i * SP, floor + 1, rowZ, ids[i]);

  const cx = x0 + rowW / 2;
  const cp = Math.cos(${EYE_PITCH});
  const camX = cx + Math.sin(${YAW}) * cp * dist;
  const camZ = rowZ + Math.cos(${YAW}) * cp * dist;
  const camY = floor + 2.2;
  g.player.pos.set(camX, camY, camZ);
  g.player.vel.set(0, 0, 0);
  g.player.flying = true;
  g.player.yaw = g.player.targetYaw = ${YAW};
  g.player.pitch = g.player.targetPitch = ${EYE_PITCH};
  return { floor: floor, x0: x0, x1: x1, z: rowZ, dist: dist, camX: camX, camY: camY, camZ: camZ,
           missing: keys.filter(function(k, i){ return ids[i] < 0; }) };
})()`);
console.log('展示台：地面 y=' + placed.floor + '，x ' + placed.x0 + '..' + placed.x1 + '，z=' + placed.z +
  '，机位后退 ' + placed.dist.toFixed(1) +
  (placed.missing.length ? '  找不到的方块: ' + placed.missing.join(',') : ''));
await sleep(3500);

const pinned = await ev(`(function(){
  const g = window.game;
  g.player.pos.set(${placed.camX}, ${placed.camY}, ${placed.camZ});
  g.player.vel.set(0, 0, 0);
  g.player.yaw = g.player.targetYaw = ${YAW};
  g.player.pitch = g.player.targetPitch = ${EYE_PITCH};
  g.started = false;
  const c = g.camera;
  return { 脚下: [+g.player.pos.x.toFixed(2), +g.player.pos.y.toFixed(2), +g.player.pos.z.toFixed(2)],
           相机: [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)] };
})()`);
console.log('冻结时相机 ' + JSON.stringify(pinned.相机));
await sleep(1200);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log('已写出 ' + OUT);

// 顺便报一下这排方块各自走哪一路材质
const batch = await ev(`(async function(){
  const B = (await import('/js/blocks.js')).BLOCKS;
  const keys = ${JSON.stringify(KEYS)};
  return keys.map(function(k){
    const b = B.find(function(b){ return b.key === k; });
    if (!b) return k + ': 不存在';
    const t = b.liquid ? '水(混合)' : (b.cutout ? '镂空(alphaTest)' : (b.transparent ? '半透明(混合)' : '不透明'));
    return k.padEnd(16) + t;
  });
})()`);
console.log('\n材质批次：');
for (const b of batch) console.log('  ' + b);

chrome.kill();
process.exit(0);
