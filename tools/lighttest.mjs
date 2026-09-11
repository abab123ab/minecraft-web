import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCK_BY_KEY } from '../js/blocks.js';

const TORCH_ID = BLOCK_BY_KEY.torch.id;
const STONE_ID = BLOCK_BY_KEY.stone.id;
const AIR_ID = BLOCK_BY_KEY.air.id;

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;
const APP = 'http://127.0.0.1:8321/';
const userDir = mkdtempSync(join(tmpdir(), 'mc-light-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=1024,640', '--user-data-dir=' + userDir
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDev() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return r.json(); } catch (e) {}
    await sleep(300);
  }
  throw new Error('devtools 未启动');
}
const version = await waitDev();

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
        this.errors.push('EXCEPTION: ' + (d.exception ? (d.exception.description || d.exception.value) : d.text));
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

const checks = [];
function check(name, ok, info) {
  checks.push({ name, ok, info });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (info !== undefined ? '  ' + JSON.stringify(info) : ''));
}

let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await ev('!!(window.game && window.game.world && window.game.world.lightAt)');
  if (ready) break;
  await sleep(300);
}
check('游戏初始化完成', ready);

if (!ready) {
  const diag = await ev('(function(){ return { hasGame: !!window.game, hasWorld: !!(window.game && window.game.world), hasLA: !!(window.game && window.game.world && window.game.world.lightAt), title: document.title, url: location.href }; })()');
  console.log('  diag:', JSON.stringify(diag));
  console.log('  cdp errors:', cdp.errors.slice(0, 5));
  console.log('----------------------------------------------');
  console.log('通过 0/' + checks.length);
  chrome.kill();
  process.exit(1);
}

await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1000);

check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3));

const surfaceLight = await ev(`(function(){
  const g = window.game;
  const x = 8, z = 8;
  let y = 79;
  while (y >= 0 && g.world.getBlock(x, y, z) === 0) y--;
  return { lt: g.world.lightAt(x, y + 1, z) };
})()`);
check('地面上方 blockLight=0', surfaceLight.lt.lit === 0, surfaceLight);
check('地面上方 sky >= 8', surfaceLight.lt.sky >= 8, surfaceLight);

const underground = await ev('(function(){ return window.game.world.lightAt(8, 4, 8); })()');
check('地下深处 sky=0', underground.sky === 0, underground);
check('地下深处 lit=0', underground.lit === 0, underground);

const placed = await ev(`(function(){
  const g = window.game;
  // 模拟挖一个 7x7x10 的小洞穴（足够覆盖火把正上方 4 格）
  for (let y = 4; y <= 13; y++) {
    for (let z = 5; z <= 11; z++) {
      for (let x = 5; x <= 11; x++) g.world.setBlock(x, y, z, 0);
    }
  }
  // 地板
  g.world.setBlock(8, 3, 8, ${STONE_ID});
  // 火把
  g.world.setBlock(8, 4, 8, ${TORCH_ID});
  for (let s = 0; s < 5; s++) {
    const ch = g.world.getChunk(0, 0);
    if (ch) g.world.buildSection(ch, s);
  }
  return true;
})()`);
check('火把已放置（挖洞后）', placed);

await sleep(500);

const torchLit = await ev('(function(){ return window.game.world.lightAt(8, 4, 8); })()');
check('火把位置 lit >= 13', torchLit.lit >= 13, torchLit);

const torchNeighbor = await ev('(function(){ return window.game.world.lightAt(10, 4, 8); })()');
check('火把 2 格邻居 lit >= 12', torchNeighbor.lit >= 12, torchNeighbor);

const torchFar = await ev('(function(){ return window.game.world.lightAt(20, 4, 8); })()');
check('火把 12 格外 lit <= 1', torchFar.lit <= 1, torchFar);

const torchUp = await ev('(function(){ return window.game.world.lightAt(8, 8, 8); })()');
check('火把正上方 lit 仍然亮', torchUp.lit >= 8, torchUp);

const hostileBlocked = await ev('(function(){ return window.game.world.lightAt(8, 4, 8); })()');
check('火把处 lit > 7（阻止敌对刷怪）', hostileBlocked.lit > 7, hostileBlocked);

const removed = await ev(`(function(){
  const g = window.game;
  g.world.setBlock(8, 4, 8, ${AIR_ID});
  for (let s = 0; s < 5; s++) {
    const ch = g.world.getChunk(0, 0);
    if (ch) g.world.buildSection(ch, s);
  }
  return true;
})()`);
check('移除火把', removed);
await sleep(300);
const afterRemove = await ev('(function(){ return window.game.world.lightAt(8, 4, 8); })()');
check('移除火把后 lit=0', afterRemove.lit === 0, afterRemove);

const fps = await ev('(async function(){ for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,16));} return window.game.fps; })()');
check('帧率 > 20', fps > 20, { fps });

check('运行期无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3));

const setTime = await ev(`(function(){
  const g = window.game;
  g.timeOfDay = 0.5;
  return { timeOfDay: g.timeOfDay };
})()`);
check('设置夜晚时间成功', setTime.timeOfDay === 0.5, setTime);

await sleep(1200);

const nightSurface = await ev(`(function(){
  const g = window.game;
  let y = 79;
  while (y >= 0 && g.world.getBlock(8, y, 8) === 0) y--;
  return { lt: g.world.lightAt(8, y + 1, 8), dayness: g.world.dayness };
})()`);
check('夜晚地面 lit=0', nightSurface.lt.lit === 0, nightSurface);
check('夜晚地面仍可见（sky_l >= 3）', nightSurface.lt.sky >= 3, nightSurface);
check('夜晚 dayness >= 0.30', nightSurface.dayness >= 0.30, nightSurface);

const nightUnderground = await ev('(function(){ return window.game.world.lightAt(8, 4, 8); })()');
check('夜晚地下 lit=0（无火把）', nightUnderground.lit === 0, nightUnderground);

await ev(`(function(){ const g = window.game; g.timeOfDay = 0.25; return g.timeOfDay; })()`);
await sleep(800);

console.log('----------------------------------------------');
const passed = checks.filter(c => c.ok).length;
console.log('通过 ' + passed + '/' + checks.length);
chrome.kill();
process.exit(passed === checks.length ? 0 : 1);
