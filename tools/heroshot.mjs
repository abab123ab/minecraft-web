// 出 README 封面图 screenshots/hero.png。
//
// 封面以前是手工拍的，仓库里没有生成器，换模型之后就一直停在旧画面上。
// 这里把它变成可复跑的：找一棵树当背景，镜头前铺一块平地摆一群生物，跑一次覆盖一次。
//
//   node tools/heroshot.mjs
//
// 需要 serve.mjs 在 127.0.0.1:8321 上跑着。
//
// 三个坑，都是踩过的：
// - 地面得自己铺。只挖空不铺地板的话，远处的生物会落到树冠上或者卡在山坡里，封面里就看不见。
//   地板的方块 id 从玩家脚下那一格读，不写死。
// - `pauseTimer` 拦不住敌对生物 —— think() 里「追玩家」那个分支排在 pauseTimer 前面，
//   所以僵尸/苦力怕照走不误（实测 2.5 秒跑掉 4 格，直接糊在镜头上）。
//   要定格只能把主循环的 started 关掉；它只停世界更新，渲染和相机同步在判断之外，照样出画。
// - 出图前把 DOM 那层 HUD 藏掉（只留 canvas），跟之前的手拍封面保持一致。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const APP = 'http://127.0.0.1:8321/';
const OUT = path.join(process.cwd(), 'screenshots', 'hero.png');

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=1280,720', '--user-data-dir=' + path.join(os.tmpdir(), 'mc-hero-' + Date.now())
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

// 1) 找一棵高树当背景：不用方块 id，直接比「这一列最高到哪」——
//    树那一列顶上还盖着树冠，比旁边草地高一截。
const placed = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.mobs.spawnTimer = 999;
  g.isDay = true;

  const topY = (x, z) => { let y = 79; while (y > 0 && g.world.getBlock(x, y, z) === 0) y--; return y; };
  const p0 = g.player.pos;
  const bx0 = Math.floor(p0.x), bz0 = Math.floor(p0.z);
  let tree = null;
  for (let dx = -14; dx <= 14; dx++) {
    for (let dz = -14; dz <= 14; dz++) {
      const y = topY(bx0 + dx, bz0 + dz);
      if (!tree || y > tree.y) tree = { x: bx0 + dx, y: y, z: bz0 + dz };
    }
  }
  if (!tree) return null;

  // 2) 站到树的斜前方，镜头对着树、再往一边偏 0.34 弧度，让树落在画面侧边
  const px = tree.x + 0.5 - 4.5, pz = tree.z + 0.5 - 3.5;
  const aim = Math.atan2(-(tree.x + 0.5 - px), -(tree.z + 0.5 - pz));
  g.player.yaw = g.player.targetYaw = aim + 0.34;
  g.player.pitch = g.player.targetPitch = -0.03;
  return { tree: tree, x: px, z: pz, yaw: g.player.yaw };
})()`);
if (!placed) throw new Error('没找到合适的树，换个种子再说');

// 3) 站位那格单独垫平，免得人卡在坡里。地板 id 从玩家脚下那格读
const stand = await ev(`(function(){
  const g = window.game;
  const x = Math.floor(${placed.x}), z = Math.floor(${placed.z});
  const floorId = g.world.getBlock(Math.floor(g.player.pos.x), Math.floor(g.player.pos.y) - 1, Math.floor(g.player.pos.z)) || 3;
  let y = 79; while (y > 0 && g.world.getBlock(x, y, z) === 0) y--;
  const top = y + 1;
  for (let dy = 0; dy <= 7; dy++) g.world.setBlock(x, top + dy, z, 0);
  g.world.setBlock(x, top - 1, z, floorId);
  g.player.pos.set(x + 0.5, top, z + 0.5);
  if (g.player.vel) g.player.vel.set(0, 0, 0);
  return { x: x, y: top, z: z, floorId: floorId };
})()`);

// 4) 镜头前铺一块平地，生物摆在这块平地上，各转一个角度（封面要能看出它们是立体的）
const cast = await ev(`(function(){
  const g = window.game;
  const p = g.player.pos;
  const yaw = g.player.yaw;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const floorId = ${stand.floorId};
  const base = Math.floor(p.y);

  // 先把镜头正前方 3 格宽的一条通道铲平，别让树挡住
  for (let f = 1; f <= 13; f++) {
    const cx = Math.floor(p.x + fx * f), cz = Math.floor(p.z + fz * f);
    for (let ax = -1; ax <= 1; ax++)
      for (let az = -1; az <= 1; az++)
        for (let dy = 0; dy <= 6; dy++) g.world.setBlock(cx + ax, base + dy, cz + az, 0);
  }

  // 近大远小地摆一群，各自转一个角度
  const list = [
    ['pig',      3.2, -1.7,  0.55],
    ['chicken',  3.4,  1.6,  1.05],
    ['sheep',    5.4, -0.4, -0.30],
    ['zombie',   7.2,  2.3,  0.30],
    ['cow',      8.4, -1.6,  0.85],
    ['creeper', 11.0,  0.4, -0.60]
  ];
  const out = [];
  for (const [type, f, r, y] of list) {
    const ix = Math.floor(p.x + fx * f + rx * r), iz = Math.floor(p.z + fz * f + rz * r);
    for (let ax = -1; ax <= 1; ax++)
      for (let az = -1; az <= 1; az++) {
        for (let dy = 0; dy <= 6; dy++) g.world.setBlock(ix + ax, base + dy, iz + az, 0);
        g.world.setBlock(ix + ax, base - 1, iz + az, floorId);
      }
    const m = g.mobs.spawn(type, ix + 0.5, base, iz + 0.5);
    m.yaw = y;
    out.push({ type: type, x: ix + 0.5, y: base, z: iz + 0.5, yaw: y });
  }
  return out;
})()`);

// 5) 跑一段物理让它们落到地板上站定
await ev(`(function(){
  const g = window.game;
  const keep = g.mobs.list.map((m) => ({ m: m, yaw: m.yaw, x: m.pos.x, z: m.pos.z }));
  for (let i = 0; i < 60; i++) {
    for (const k of keep) {
      k.m.vel.set(0, 0, 0);
      k.m.yaw = k.yaw;
      k.m.pos.x = k.x;
      k.m.pos.z = k.z;
    }
    g.updateMobs(0.016);
  }
  return keep.length;
})()`);
await sleep(2500);

// 6) 定格：关掉主循环的世界更新（敌对生物光靠 pauseTimer 是拦不住的），
//    再把位置按回目标，跑一次 dt=0 的更新把 mesh 同步过去
const frozen = await ev(`(function(){
  const g = window.game;
  const want = ${JSON.stringify(cast)};
  g.started = false;
  for (const m of g.mobs.list) {
    const w = want.find((v) => v.type === m.type);
    if (!w) continue;
    m.pos.x = w.x;
    m.pos.y = w.y;   // 地板就铺在 w.y-1，钉回去免得跑偏的生物陷进地里
    m.pos.z = w.z;
    m.yaw = w.yaw;
    m.vel.set(0, 0, 0);
  }
  g.updateMobs(0);
  return g.mobs.list.map((m) => [m.type, +m.pos.x.toFixed(2), +m.pos.y.toFixed(2), +m.pos.z.toFixed(2)]);
})()`);

// 7) 藏掉 DOM 那层 HUD，只留 3D 画面
await ev(`(function(){
  for (const el of document.body.children) {
    if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden';
  }
  return true;
})()`);
await sleep(500);

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
const b = fs.readFileSync(OUT);

console.log('背景树 ' + JSON.stringify(placed.tree) + '  站位 ' + JSON.stringify(stand) + '  yaw ' + placed.yaw.toFixed(3));
console.log('出场 ' + cast.length + ' 只（定格后坐标）：');
for (const [type, x, y, z] of frozen) console.log('  ' + type.padEnd(8) + x + ', ' + y + ', ' + z);
console.log('封面 -> ' + path.relative(process.cwd(), OUT) + '  ' + b.readUInt32BE(16) + 'x' + b.readUInt32BE(20));

chrome.kill();
process.exit(0);
