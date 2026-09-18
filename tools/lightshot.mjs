import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9353;
const APP = 'http://127.0.0.1:8321/';
const OUT = 'E:/Code/minecraft-web/screenshots';
const userDir = path.join(os.tmpdir(), 'mc-lightshot-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=900,560', '--user-data-dir=' + userDir
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
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id).resolve(msg); this.pending.delete(msg.id); }
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
await sleep(3000);

async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('evaluate 失败: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}

let ready = false;
for (let i = 0; i < 40; i++) {
  ready = await ev('!!(window.game && window.game.world)');
  if (ready) break;
  await sleep(300);
}
if (!ready) { console.log('游戏未初始化'); chrome.kill(); process.exit(1); }

await ev('(function(){ const b=document.getElementById("start-btn"); if(b) b.click(); return true; })()');
await ev(`(function(){
  for (const id of ['hotbar','survival-bar','debug','coord','crosshair','hand','minebar','hud']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  return true;
})()`);
await sleep(4000);

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.result.data, 'base64');
  let f = path.join(OUT, name + '.png');
  try {
    fs.writeFileSync(f, buf);
  } catch (e) {
    // 同名文件被外部进程占着（EPERM/EBUSY）时不能整个脚本挂掉，换个名字继续，否则后面的对照全跑不到。
    if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
    f = path.join(OUT, name + '-' + Date.now() + '.png');
    fs.writeFileSync(f, buf);
    console.log('  ! ' + name + '.png 被占用，改存 ' + path.basename(f));
  }
  console.log('  已存 ' + path.basename(f) + '  (' + fs.statSync(f).size + ' bytes)');
}

// elev = sin(t*2PI - PI/2) → t=0 午夜、t=0.25 日出、t=0.5 正午、t=0.75 日落
const NOON = 0.5, MIDNIGHT = 0.0;

// ---- A 地表正午 ----
await ev(`(function(){
  const g = window.game;
  g.player.pitch = -0.18; g.player.targetPitch = -0.18;
  g.player.yaw = 0.6; g.player.targetYaw = 0.6;
  g.timeOfDay = ${NOON};
  return true;
})()`);
await sleep(2500);
await shot('light-surface-day');

// ---- B 地表午夜（同一机位） ----
await ev(`(function(){ window.game.timeOfDay = ${MIDNIGHT}; return true; })()`);
await sleep(2500);
await shot('light-surface-night');

// ---- 挖一个封闭竖井（封顶切断天光），做火把对照 ----
const dig = await ev(`(async function(){
  const g = window.game, w = g.world;
  const bmod = await import('/js/blocks.js');
  const AIR = 0, TORCH = bmod.BLOCK_BY_KEY.torch.id;
  const STONE = bmod.BLOCK_BY_KEY.stone.id;
  const px = Math.floor(g.player.pos.x), pz = Math.floor(g.player.pos.z);
  let sy = 79;
  while (sy > 0 && w.getBlock(px, sy, pz) === AIR) sy--;
  const floorY = sy - 8;
  for (let yy = sy; yy >= floorY; yy--) {
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      w.setBlock(px + dx, yy, pz + dz, AIR);
    }
  }
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    w.setBlock(px + dx, sy + 1, pz + dz, STONE);
  }
  g.player.pos.set(px + 0.5, floorY, pz + 1.5);
  g.player.vel.set(0, 0, 0);
  g.timeOfDay = ${NOON};
  return { surfaceY: sy, floorY: floorY, px: px, pz: pz };
})()`);
console.log('  封闭竖井: ' + JSON.stringify(dig));

async function freeze(y) {
  await ev(`(function(){
    const g = window.game;
    g.player.pos.set(${dig.px} + 0.5, ${y}, ${dig.pz} + 1.5);
    g.player.vel.set(0, 0, 0);
    g.player.flying = true;
    g.player.pitch = 0.0; g.player.targetPitch = 0.0;
    g.player.yaw = 1.57; g.player.targetYaw = 1.57;
    g.timeOfDay = ${NOON};
    return true;
  })()`);
}

// ---- C 无火把：应明显暗 ----
await freeze(dig.floorY);
await sleep(3000);
await shot('light-underground-dark');

// ---- D 有火把：应在火把附近出现暖色光晕 ----
await ev(`(async function(){
  const g = window.game, w = g.world;
  const bmod = await import('/js/blocks.js');
  const TORCH = bmod.BLOCK_BY_KEY.torch.id;
  const px = ${dig.px}, pz = ${dig.pz}, y = ${dig.floorY};
  w.setBlock(px, y, pz - 1, TORCH);
  w.setBlock(px - 1, y, pz + 1, TORCH);
  w.setBlock(px + 1, y, pz + 1, TORCH);
  return true;
})()`);
await freeze(dig.floorY);
await sleep(3000);
await shot('light-underground-torch');

// ---- 数值分析：两张图逐像素对比 ----
const diff = await ev(`(async function(){
  const load = async function(u){
    const r = await fetch(u);
    const b = await r.blob();
    return await createImageBitmap(b);
  };
  const a = await load('/screenshots/light-underground-dark.png');
  const b = await load('/screenshots/light-underground-torch.png');
  const cv = document.createElement('canvas');
  cv.width = a.width; cv.height = a.height;
  const cx = cv.getContext('2d');
  cx.drawImage(a, 0, 0);
  const da = cx.getImageData(0, 0, cv.width, cv.height).data;
  cx.clearRect(0, 0, cv.width, cv.height);
  cx.drawImage(b, 0, 0);
  const db = cx.getImageData(0, 0, cv.width, cv.height).data;
  let sumA = 0, sumB = 0, n = 0, brighter = 0, sumBr = 0, sumBg = 0, sumBb = 0, warmCount = 0;
  for (let i = 0; i < da.length; i += 4) {
    const ar = da[i], ag = da[i+1], ab = da[i+2];
    const br = db[i], bg = db[i+1], bb = db[i+2];
    sumA += (ar + ag + ab) / 3;
    sumB += (br + bg + bb) / 3;
    n++;
    if ((br + bg + bb) - (ar + ag + ab) > 24) {
      brighter++; sumBr += br; sumBg += bg; sumBb += bb;
      if (br > bb + 8) warmCount++;
    }
  }
  return {
    尺寸: cv.width + 'x' + cv.height,
    无火把平均亮度: Math.round(sumA / n * 10) / 10,
    有火把平均亮度: Math.round(sumB / n * 10) / 10,
    显著变亮像素占比: Math.round(brighter / n * 1000) / 10,
    变亮区域平均RGB: brighter ? [Math.round(sumBr/brighter), Math.round(sumBg/brighter), Math.round(sumBb/brighter)] : null,
    变亮区域偏暖像素占比: brighter ? Math.round(warmCount / brighter * 1000) / 10 : null
  };
})()`);
console.log('\n  ===== 火把对照数值分析 =====');
for (const k of Object.keys(diff)) console.log('  ' + k + ': ' + JSON.stringify(diff[k]));

// ---- 顶点色层面：火把附近的面到底偏暖还是偏冷 ----
const probe = await ev(`(function(){
  const w = window.game.world;
  const px = ${dig.px}, pz = ${dig.pz}, y = ${dig.floorY};
  const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
  const ch = w.getChunk(cx, cz);
  if (!ch) return { err: '区块不在内存' };
  const si = Math.floor(y / 16);
  const sec = ch.secs[si];
  if (!sec || !sec.o) return { err: '该 section 无网格' };
  const a = sec.o.geometry.attributes.color.array;
  const triples = [];
  for (let i = 0; i < a.length; i += 3) triples.push([a[i], a[i+1], a[i+2]]);
  triples.sort(function(p, q){ return q[0] - p[0]; });
  const top = triples.slice(0, 20);
  const bot = triples.slice(-20);
  const mean = function(list){
    const s = [0,0,0];
    for (const t of list) { s[0] += t[0]; s[1] += t[1]; s[2] += t[2]; }
    return s.map(function(v){ return Math.round(v / list.length * 1000) / 1000; });
  };
  const idx = function(x, yy, z){ return x + 16 * (z + 16 * yy); };
  const lx = px - cx * 16, lz = pz - cz * 16;
  return {
    section: si,
    顶点数: triples.length,
    最亮20个顶点均值RGB: mean(top),
    最暗20个顶点均值RGB: mean(bot),
    火把格blockLight: ch.blockLight[idx(lx, y, lz - 1)],
    房间中心blockLight: ch.blockLight[idx(lx, y, lz)],
    房间中心skyLight: ch.skyLight[idx(lx, y, lz)]
  };
})()`);
console.log('\n  ===== 顶点色层面（与贴图无关）=====');
for (const k of Object.keys(probe)) console.log('  ' + k + ': ' + JSON.stringify(probe[k]));

// ---- 正午 vs 午夜 的整图差异 ----
const dnd = await ev(`(async function(){
  const load = async function(u){
    const r = await fetch(u);
    return await createImageBitmap(await r.blob());
  };
  const a = await load('/screenshots/light-surface-day.png');
  const b = await load('/screenshots/light-surface-night.png');
  const cv = document.createElement('canvas');
  cv.width = a.width; cv.height = a.height;
  const cx = cv.getContext('2d');
  cx.drawImage(a, 0, 0);
  const da = cx.getImageData(0, 0, cv.width, cv.height).data;
  cx.clearRect(0, 0, cv.width, cv.height);
  cx.drawImage(b, 0, 0);
  const db = cx.getImageData(0, 0, cv.width, cv.height).data;
  let sa = 0, sb = 0, n = 0, darker = 0;
  for (let i = 0; i < da.length; i += 4) {
    const va = (da[i] + da[i+1] + da[i+2]) / 3;
    const vb = (db[i] + db[i+1] + db[i+2]) / 3;
    sa += va; sb += vb; n++;
    if (va - vb > 8) darker++;
  }
  return {
    正午平均亮度: Math.round(sa / n * 10) / 10,
    午夜平均亮度: Math.round(sb / n * 10) / 10,
    午夜更暗像素占比: Math.round(darker / n * 1000) / 10
  };
})()`);
console.log('\n  ===== 正午 vs 午夜 =====');
for (const k of Object.keys(dnd)) console.log('  ' + k + ': ' + JSON.stringify(dnd[k]));

chrome.kill();
process.exit(0);


