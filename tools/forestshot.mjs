// 出 README 那张森林图：screenshots/forest.png + screenshots/forest-outside.png。
//
//   node tools/forestshot.mjs [输出png] [抬头弧度]
//
// 做的事：在森林里找一个「头顶盖着厚树冠、但人站得进去」的落脚点 →
//   ① 站在原地抬头拍一张（叶隙里该能看见天）
//   ② 退到树冠外、从高处拍一张整棵树（从外面看树冠的镂空）
// 顺带报出「树冠底下有多少格能见到完整天光」—— 树叶只挡 1 级光，这个数会明显变大。
//
// 需要 serve.mjs 在 127.0.0.1:8321 上跑着。
//
// 四个坑：
// - 落脚点要按「正头顶有没有树冠」挑，不能按「附近叶子多」挑 —— 后者经常挑到林间空地，
//   抬头是一片天，白拍。
// - 还要排除「紧挨着树干」的列。只按树冠厚度挑的话，选出来的往往是树干边上的那一格，
//   镜头离原木不到一格，右半屏会整块糊成木纹。
//   注意密林里「离树干 3 格以外」的带冠列基本不存在（实测 61x61 范围里最近原木
//   全是 1~2 格），所以门槛只能卡在 2：排除 8 个紧邻格，再把朝向算成「背对最近那棵树」。
// - 树冠底到地面之间要留 2 格净空，否则相机（脚 + 1.62）会卡在树叶方块内部。
// - 别在量光照之前改世界。第一版为了腾地方把头顶 6 格挖空了，再量「树冠挡了多少光」，
//   量到的是拆掉树冠之后的数（全 15）。现在测量在前、改世界在后，而且不再挖头顶。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9382;
const APP = 'http://127.0.0.1:8321/';
const OUT = process.argv[2] || path.join(process.cwd(), 'screenshots', 'forest.png');
const PITCH = process.argv[3] ? parseFloat(process.argv[3]) : 0.62;

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=1280,720', '--user-data-dir=' + path.join(os.tmpdir(), 'mc-forest-' + Date.now())
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

// 1) 选落脚点：头顶盖着厚树冠 + 站得进去 + 离树干两格以上
const spot = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/blocks.js');
  const LEAF = { leaves: 1, spruce_leaves: 1 };
  const isLeaf = function(x, y, z){ const b = mod.BLOCKS[g.world.getBlock(x, y, z)]; return !!b && !!LEAF[b.key]; };
  const info = function(x, z){
    let top = 79; while (top > 0 && g.world.getBlock(x, top, z) === 0) top--;
    if (!isLeaf(x, top, z)) return null;
    let n = 0;
    for (let y = top; y > top - 14 && isLeaf(x, y, z); y--) n++;
    if (n < 3) return null;
    const canopy = top - n + 1;
    let gy = canopy - 1;
    while (gy > 0 && g.world.getBlock(x, gy, z) === 0) gy--;
    const gb = mod.BLOCKS[g.world.getBlock(x, gy, z)];
    if (!gb || !gb.solid || LEAF[gb.key]) return null;
    if (canopy - gy - 1 < 2) return null;
    // 离最近的原木至少 2 格（排除 8 个紧邻格），否则镜头贴着树干
    let logD = 99, lx = 0, lz = 0;
    for (let ax = -3; ax <= 3; ax++) {
      for (let az = -3; az <= 3; az++) {
        if (ax === 0 && az === 0) continue;
        for (let y = gy + 1; y <= top; y++) {
          const b = mod.BLOCKS[g.world.getBlock(x + ax, y, z + az)];
          if (b && b.key === 'log') {
            const d = Math.max(Math.abs(ax), Math.abs(az));
            if (d < logD) { logD = d; lx = x + ax; lz = z + az; }
          }
        }
      }
    }
    if (logD < 2) return null;
    return { x: x, z: z, n: n, top: top, canopy: canopy, ground: gy, stand: gy + 1,
             gap: canopy - gy - 1, logD: logD, lx: lx, lz: lz };
  };
  g.mobs.clear();
  g.mobs.spawnTimer = 999;
  g.isDay = true;
  const p0 = g.player.pos;
  const bx0 = Math.floor(p0.x), bz0 = Math.floor(p0.z);
  let best = null;
  for (let dx = -26; dx <= 26; dx++) {
    for (let dz = -26; dz <= 26; dz++) {
      const c = info(bx0 + dx, bz0 + dz);
      if (c && (!best || c.n > best.n
        || (c.n === best.n && (c.gap > best.gap
          || (c.gap === best.gap && c.logD > best.logD))))) best = c;
    }
  }
  return best;
})()`);
if (!spot) throw new Error('附近没有「头顶有树冠、又站得进去」的落脚点，换个种子或走远点再试');
console.log('落脚点 ' + spot.x + ',' + spot.z + '：头顶连着 ' + spot.n + ' 格树叶，'
  + '树冠底 y=' + spot.canopy + '、地面 y=' + spot.ground + '（净空 ' + spot.gap + ' 格），'
  + '最近的原木在 ' + spot.lx + ',' + spot.lz + '（' + spot.logD + ' 格外）');

// 2) 先量光，再改世界
const light = await ev(`(function(){
  const g = window.game;
  const rows = [];
  for (let y = ${spot.top}; y >= ${spot.ground}; y--) {
    const L = g.world.lightAt(${spot.x}, y, ${spot.z});
    rows.push({ y: y, id: g.world.getBlock(${spot.x}, y, ${spot.z}), sky: L.sky, lit: L.lit });
  }
  return rows;
})()`);
console.log('\n落脚点那一列的光照（y / 方块id / 天光 / 方块光）：');
for (const r of light) {
  console.log('  ' + String(r.y).padStart(3) + '   ' + String(r.id).padStart(6) + '   ' + String(r.sky).padStart(4) + '   ' + String(r.lit).padStart(5));
}

const cover = await ev(`(function(){
  const g = window.game;
  let n = 0, sum = 0, full = 0, lo = 15, hi = 0;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      const x = ${spot.x} + dx, z = ${spot.z} + dz;
      const y = ${spot.ground + 1};
      if (g.world.getBlock(x, y, z) !== 0) continue;
      const s = g.world.lightAt(x, y, z).sky;
      n++; sum += s;
      if (s === 15) full++;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
  }
  return { n: n, avg: sum / n, full: full, lo: lo, hi: hi };
})()`);
console.log('\n落脚点四周 13x13、贴地那一层（y=' + (spot.ground + 1) + '）的天光：'
  + '平均 ' + cover.avg.toFixed(1) + '，最低 ' + cover.lo + '、最高 ' + cover.hi
  + '，其中满值 15 的 ' + cover.full + '/' + cover.n + ' 格（' + (cover.full / cover.n * 100).toFixed(1) + '%）');

// 3) 站进树冠底下抬头
await ev(`(function(){
  const g = window.game;
  g.player.pos.set(${spot.x} + 0.5, ${spot.stand}, ${spot.z} + 0.5);
  g.player.vel.set(0, 0, 0);
  g.player.flying = true;
  // 背对最近那棵树干，免得木纹糊住半个画面
  g.player.yaw = g.player.targetYaw = Math.atan2(-(${spot.x} - ${spot.lx}), -(${spot.z} - ${spot.lz}));
  g.player.pitch = g.player.targetPitch = ${PITCH};
  return 1;
})()`);
await sleep(4000);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log('\n已写出 ' + OUT);

// 4) 退到树冠外高处，从外面拍整棵树
const back = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/blocks.js');
  const LEAF = { leaves: 1, spruce_leaves: 1 };
  // 找最近的树干列（树冠底下那一根）
  let trunk = null;
  for (let r = 1; r <= 9 && !trunk; r++) {
    for (let ax = -r; ax <= r && !trunk; ax++) {
      for (let az = -r; az <= r; az++) {
        if (Math.max(Math.abs(ax), Math.abs(az)) !== r) continue;
        const x = ${spot.x} + ax, z = ${spot.z} + az;
        for (let y = ${spot.top}; y >= ${spot.ground}; y--) {
          const b = mod.BLOCKS[g.world.getBlock(x, y, z)];
          if (b && b.key === 'log') { trunk = { x: x, z: z, y: y }; break; }
        }
        if (trunk) break;
      }
    }
  }
  if (!trunk) trunk = { x: ${spot.x}, z: ${spot.z}, y: ${spot.ground} };
  const tx = trunk.x + 0.5, tz = trunk.z + 0.5, ty = ${spot.top} - 1.5;
  const isLeafId = function(id){ const b = mod.BLOCKS[id]; return !!b && !!LEAF[b.key]; };
  // 密林里随便挑个方位退出来，十有八九正对着另一棵树。绕树转一圈，
  // 挑「机位站在空气里 + 视线里除了自己这棵树的叶子没有别的东西挡着」的那个角度。
  //
  // 退得太近只有一面绿墙 —— 密林的树冠是连成片的，10 格处根本读不出「一棵树」。
  // 所以拉到 26~34 格、比树冠高 7 格俯视 15° 左右，出的是「林海 + 天际线」。
  let cam = null;
  for (let di = 0; di < 3; di++) {
    const D = 26 + di * 4;
    for (let k = 0; k < 24; k++) {
      const A = k * Math.PI / 12;
      const camX = tx + Math.sin(A) * D, camZ = tz + Math.cos(A) * D;
      const camY = ty + 7.0;
      const fx = Math.floor(camX), fz = Math.floor(camZ), fy = Math.floor(camY);
      let bad = 0;
      // 机位脚下和头顶两格得是空气
      if (g.world.getBlock(fx, fy, fz) !== 0) bad += 100;
      if (g.world.getBlock(fx, fy + 1, fz) !== 0) bad += 100;
      // 下面 40 格内没有地面 = 区块还没加载，等于拍到一片空气
      let grounded = false;
      for (let y = fy; y > fy - 40 && y > 0; y--) if (g.world.getBlock(fx, y, fz) !== 0) { grounded = true; break; }
      if (!grounded) bad += 200;
      // 视线：除了树叶，撞到别的方块就算遮挡
      const ey = camY + 1.62;
      const vx = tx - camX, vy = ty - ey, vz = tz - camZ;
      const len = Math.hypot(vx, vy, vz);
      let hit = 0;
      for (let s = 0.4; s < len; s += 0.4) {
        const id = g.world.getBlock(
          Math.floor(camX + vx * s / len),
          Math.floor(ey + vy * s / len),
          Math.floor(camZ + vz * s / len));
        if (id !== 0 && !isLeafId(id)) hit++;
      }
      const score = bad + hit;
      if (!cam || score < cam.score) cam = { A: A, D: D, camX: camX, camY: camY, camZ: camZ, score: score, hit: hit, bad: bad };
    }
  }
  g.player.pos.set(cam.camX, cam.camY, cam.camZ);
  g.player.vel.set(0, 0, 0);
  g.player.flying = true;
  g.player.yaw = g.player.targetYaw = Math.atan2(-(tx - cam.camX), -(tz - cam.camZ));
  // 瞄准点比树冠中心再低 5 格，不然天空要占掉小半个画面
  g.player.pitch = g.player.targetPitch = Math.atan2((ty - 5) - (cam.camY + 1.62), Math.hypot(tx - cam.camX, tz - cam.camZ));
  return { trunk: trunk, cam: cam, pitch: g.player.pitch };
})()`);
console.log('树外视角：树干在 ' + back.trunk.x + ',' + back.trunk.z + '，机位 '
  + back.cam.camX.toFixed(1) + ',' + back.cam.camY.toFixed(1) + ',' + back.cam.camZ.toFixed(1)
  + '（距离 ' + back.cam.D + '、方位 ' + (back.cam.A * 180 / Math.PI).toFixed(0) + '°、'
  + '视线遮挡 ' + back.cam.hit + '、机位扣分 ' + back.cam.bad + '），俯角 '
  + (back.pitch * 180 / Math.PI).toFixed(1) + '°');
await sleep(4000);
const out2 = OUT.replace(/\.png$/, '-outside.png');
const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
fs.writeFileSync(out2, Buffer.from(shot2.result.data, 'base64'));
console.log('已写出 ' + out2);

chrome.kill();
process.exit(0);
