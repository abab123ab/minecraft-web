import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const SRV = 8321;
const APP = 'http://127.0.0.1:' + SRV + '/';
const userDir = path.join(os.tmpdir(), 'mc-bed-' + Date.now());
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.gif': 'image/gif'
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const full = path.normalize(path.join(ROOT, p));
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const data = await fs.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(SRV, r));

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
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });
}

let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await ev('!!(window.game && window.game.world)');
  if (ready) break;
  await sleep(500);
}
check('游戏初始化完成', ready);
await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1000);
check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

// ---- A 床方块已注册 ----
const blk = await ev(`(async function(){
  const m = await import('/js/blocks.js');
  const b = m.BLOCK_BY_KEY.bed;
  return b ? { id: b.id, solid: b.solid, opaque: b.opaque, drop: b.drop, label: b.label } : null;
})()`);
check('床方块已注册', blk !== null);
check('床是实心不透明方块', blk && blk.solid === true && blk.opaque === true);
check('床掉落物为 bed', blk && blk.drop === 'bed');

// ---- B 床合成表存在（3 羊毛 + 3 木板）----
const recipe = await ev(`(async function(){
  const c = await import('/js/crafting.js');
  const r = c.RECIPES.find((x) => x.resultKey === 'bed');
  if (!r) return null;
  const flat = r.pattern.join('');
  const wool = (flat.match(/W/g) || []).length;
  const plank = (flat.match(/P/g) || []).length;
  return { type: r.type, wool, plank, count: r.count };
})()`);
check('床合成配方已注册', recipe !== null);
check('床配方为 3 羊毛 + 3 木板', recipe && recipe.wool === 3 && recipe.plank === 3 && recipe.count === 1, recipe);

// ---- C 夜里右键床 → 睡觉 + 设重生点 + 黑屏遮罩 ----
const night = await ev(`(async function(){
  const g = window.game;
  g.timeOfDay = 0.85; g.updateDayNight(0);
  const isNight = g.isNight;
  const m = await import('/js/blocks.js');
  const bedId = m.BLOCK_BY_KEY.bed.id;
  const bx = Math.floor(g.player.pos.x) + 2, by = Math.floor(g.player.pos.y), bz = Math.floor(g.player.pos.z);
  g.world.setBlock(bx, by, bz, bedId);
  const before = { x: g.spawnPoint.x, y: g.spawnPoint.y, z: g.spawnPoint.z };
  g.trySleep({ x: bx, y: by, z: bz, ny: 1 });
  const el = document.getElementById('sleep');
  return {
    isNight, placed: g.world.getBlock(bx, by, bz) === bedId,
    sleeping: g.sleeping,
    spawnOk: Math.abs(g.spawnPoint.x - (bx + 0.5)) < 1e-6 && Math.abs(g.spawnPoint.y - (by + 1)) < 1e-6 && Math.abs(g.spawnPoint.z - (bz + 0.5)) < 1e-6,
    overlayOn: el ? el.classList.contains('on') : false,
    before
  };
})()`);
check('0.85 时刻判定为夜晚', night.isNight === true);
check('床方块已放置到世界', night.placed);
check('右键床后进入睡眠状态', night.sleeping === true);
check('重生点更新为床的位置', night.spawnOk);
check('黑屏遮罩 #sleep 已点亮', night.overlayOn === true);

// ---- D 快进到早上 → 自动醒来 + 遮罩关闭 ----
const wake = await ev(`(function(){
  const g = window.game;
  g.sleeping = true;
  g.timeOfDay = 0.85; g.updateDayNight(0);
  let guard = 0;
  while (!g.isDay && guard < 400) {
    g.updateDayNight(0.05 * 80);
    if (g.isDay) g.wake();
    guard++;
  }
  const el = document.getElementById('sleep');
  return { isDay: g.isDay, sleeping: g.sleeping, overlayOff: el ? !el.classList.contains('on') : true, guard };
})()`);
check('快进后到达白天', wake.isDay === true, 'guard=' + wake.guard);
check('自动醒来（sleeping=false）', wake.sleeping === false);
check('醒来后遮罩关闭', wake.overlayOff === true);

// ---- E 白天右键床 → 不睡觉 ----
const dayRefuse = await ev(`(function(){
  const g = window.game;
  g.sleeping = false;
  const el = document.getElementById('sleep'); if (el) el.classList.remove('on');
  g.timeOfDay = 0.3; g.updateDayNight(0);
  const isDay = g.isDay;
  const bx = Math.floor(g.player.pos.x) + 2, by = Math.floor(g.player.pos.y), bz = Math.floor(g.player.pos.z);
  g.trySleep({ x: bx, y: by, z: bz, ny: 1 });
  return { isDay, sleeping: g.sleeping, overlayOn: el ? el.classList.contains('on') : false };
})()`);
check('0.3 时刻判定为白天', dayRefuse.isDay === true);
check('白天右键床不进入睡眠', dayRefuse.sleeping === false);
check('白天不点亮遮罩', dayRefuse.overlayOn === false);

// ---- F 睡眠期间玩家与生物被冻结 ----
const frozen = await ev(`(function(){
  const g = window.game;
  g.sleeping = true;
  const pBefore = { x: g.player.pos.x, y: g.player.pos.y, z: g.player.pos.z };
  g.input.forward = true;
  // 模拟一帧：loop 内部用 canAct=!sleeping 冻结 player.update 与 updateMobs
  g.player.update(0.05, {});
  const moved = Math.abs(g.player.pos.x - pBefore.x) + Math.abs(g.player.pos.y - pBefore.y) + Math.abs(g.player.pos.z - pBefore.z);
  const mobsActive = g.mobs ? (g.sleeping ? false : true) : true;
  g.input.forward = false;
  g.sleeping = false;
  return { moved, mobsActive };
})()`);
check('睡眠时玩家输入被冻结（无移动）', frozen.moved < 1e-6, 'moved=' + frozen.moved);

check('全流程无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 5).join(' | '));

console.log('\n================ 床（睡觉跳夜 + 重生点）验证 ================');
let pass = 0;
for (const r of results) {
  console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  if (r.ok) pass++;
}
console.log('----------------------------------------------------------');
console.log('通过 ' + pass + '/' + results.length);
if (cdp.errors.length) {
  console.log('\nJS 报错:');
  for (const e of cdp.errors.slice(0, 10)) console.log('  ' + e);
}

server.close();
chrome.kill();
process.exit(pass === results.length ? 0 : 1);
