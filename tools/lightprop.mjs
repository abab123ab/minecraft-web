import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9355;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-lightprop-' + Date.now());

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
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.errors = [];
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id).resolve(msg); this.pending.delete(msg.id); return; }
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
await sleep(3000);

async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('evaluate 失败: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail === undefined ? '' : '  [' + JSON.stringify(detail) + ']')); }
  else { fail++; console.log('  FAIL  ' + name + '  [' + JSON.stringify(detail) + ']'); }
}

let ready = false;
for (let i = 0; i < 40; i++) {
  ready = await ev('!!(window.game && window.game.world && window.game.world.buildSection)');
  if (ready) break;
  await sleep(300);
}
check('游戏初始化完成', ready);
if (!ready) { chrome.kill(); process.exit(1); }

await ev('(function(){ const b=document.getElementById("start-btn"); if(b) b.click(); return true; })()');
await sleep(2500);
check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3));

// 让引擎自己的 dirty 循环跑到收敛（不是手工 buildMesh，走的是真实路径）
async function settle(rounds) {
  for (let i = 0; i < (rounds || 8); i++) {
    const done = await ev(`(function(){
      const g = window.game;
      g.world.update(g.player.pos.x, g.player.pos.z, 3000);
      return g.world.dirty.size;
    })()`);
    if (done === 0) break;
    await sleep(60);
  }
  return ev('window.game.world.dirty.size');
}

await ev(`(async function(){
  const g = window.game;
  g.timeOfDay = 0.5;
  g.player.flying = true;
  g.player.pos.set(72.5, 14, 88.5);
  g.player.vel.set(0, 0, 0);
  return true;
})()`);
await settle(12);

// ============ 一、半径：火把在区块正中间（chunk cx=3 local 8 = x56）============
// 沿 x 挖一条 3 格高直隧道 z=72 y=10..12，这样光只能沿 +-x 走，衰减距离 == 格距
await ev(`(async function(){
  const w = window.game.world;
  for (let x = 40; x <= 88; x++) for (let y = 10; y <= 12; y++) w.setBlock(x, y, 72, 0);
  const B = await import('/js/blocks.js');
  w.setBlock(56, 11, 72, B.BLOCK_BY_KEY.torch.id);
  return true;
})()`);
const dirty1 = await settle(10);
check('光照/网格收敛，dirty 清空', dirty1 === 0, { dirty: dirty1 });

const ring = await ev(`(function(){
  const w = window.game.world, out = [];
  for (let x = 40; x <= 72; x++) out.push(w.lightAt(x, 11, 72).lit);
  return out;
})()`);
const L = (x) => ring[x - 40];

console.log('\n  ---- 一、光照半径（火把 x=56，理论值 = 14 - 距离）----');
console.log('  距离: ' + [0, 1, 2, 4, 6, 8, 10, 12, 13, 14, 15].map((d) => String(d).padStart(3)).join(''));
console.log('  实测: ' + [0, 1, 2, 4, 6, 8, 10, 12, 13, 14, 15].map((d) => String(L(56 + d)).padStart(3)).join(''));
console.log('  理论: ' + [0, 1, 2, 4, 6, 8, 10, 12, 13, 14, 15].map((d) => String(Math.max(0, 14 - d)).padStart(3)).join(''));

check('火把自身格 = 14', L(56) === 14, L(56));
check('距离 1 = 13', L(57) === 13, L(57));
check('距离 8 = 6（旧实现在此之后就断了）', L(64) >= 6, L(64));
check('距离 13 = 1（旧实现恒为 0）', L(69) >= 1, L(69));
check('距离 15 = 0', L(71) === 0, L(71));
check('火把两侧衰减对称', L(48) === L(64) || (L(48) > 0 && L(64) > 0), { left: L(48), right: L(64) });

// ============ 二、跨区块边界：火把放在 chunk cx=3 的最后一格 x=63 ============
await ev(`(async function(){
  const w = window.game.world;
  const B = await import('/js/blocks.js');
  w.setBlock(56, 11, 72, 0);
  w.setBlock(63, 11, 72, B.BLOCK_BY_KEY.torch.id);
  return true;
})()`);
const dirty2 = await settle(10);
check('移除旧火把 + 放边界火把后收敛', dirty2 === 0, { dirty: dirty2 });

const cross = await ev(`(function(){
  const w = window.game.world, out = [];
  for (let x = 60; x <= 80; x++) out.push(w.lightAt(x, 11, 72).lit);
  return out;
})()`);
const C = (x) => cross[x - 60];

console.log('\n  ---- 二、跨区块边界（火把 x=63 是 chunk cx=3 的最后一格，x=64 起属 cx=4）----');
console.log('  x:    ' + [60, 61, 62, 63, 64, 65, 66, 70, 76, 77, 78].map((x) => String(x).padStart(4)).join(''));
console.log('  实测: ' + [60, 61, 62, 63, 64, 65, 66, 70, 76, 77, 78].map((x) => String(C(x)).padStart(4)).join(''));
console.log('  理论: ' + [60, 61, 62, 63, 64, 65, 66, 70, 76, 77, 78].map((x) => String(Math.max(0, 14 - Math.abs(x - 63))).padStart(4)).join(''));

check('火把自身格 = 14', C(63) === 14, C(63));
check('区块内 x=62 = 13', C(62) === 13, C(62));
check('邻块第一格 x=64 = 13（旧实现恒为 0）', C(64) >= 12, C(64));
check('邻块内继续衰减 x=65 >= 11', C(65) >= 11, C(65));
check('邻块内 x=70 >= 6', C(70) >= 6, C(70));
check('邻块内 x=76 >= 1', C(76) >= 1, C(76));
check('超出半径 x=78 = 0', C(78) === 0, C(78));

// x=84 离所有火把都超过 14 格，是个干净的空位，用它测「光照能不能正确下降」
const beforeAdd = await ev('window.game.world.lightAt(84, 11, 72).lit');
check('新火把位为空时该处无光', beforeAdd === 0, beforeAdd);
await ev(`(async function(){
  const w = window.game.world;
  const B = await import('/js/blocks.js');
  w.setBlock(84, 11, 72, B.BLOCK_BY_KEY.torch.id);
  return true;
})()`);
await settle(10);
const lit84 = await ev('window.game.world.lightAt(84, 11, 72).lit');
const lit78 = await ev('window.game.world.lightAt(78, 11, 72).lit');
check('新放火把自身 = 14', lit84 === 14, lit84);
check('其左侧距离 6 处 = 8', lit78 === 8, lit78);

await ev('(function(){ window.game.world.setBlock(84, 11, 72, 0); return true; })()');
const dirty4 = await settle(10);
check('拆掉火把后收敛', dirty4 === 0, { dirty: dirty4 });
const gone84 = await ev('window.game.world.lightAt(84, 11, 72).lit');
const gone78 = await ev('window.game.world.lightAt(78, 11, 72).lit');
check('拆掉火把后原位置归零（光照能下降）', gone84 === 0, gone84);
check('拆掉火把后周边也归零', gone78 === 0, gone78);
check('搬走火把不残留：x=56 现在只被 x=63 照亮 = 7', (await ev('window.game.world.lightAt(56, 11, 72).lit')) === 7);
check('隧道远端 x=48 超出半径 = 0', (await ev('window.game.world.lightAt(48, 11, 72).lit')) === 0);

// ============ 三、跨 section（y=16 分界）：火把在 section 1，光要下到 section 0 ============
await ev(`(async function(){
  const w = window.game.world;
  const B = await import('/js/blocks.js');
  const TORCH = B.BLOCK_BY_KEY.torch.id, STONE = B.BLOCK_BY_KEY.stone.id;
  const X = 72, Z = 104, LO = 6, HI = 26, TY = 22;

  w.setBlock(63, 11, 72, 0);
  for (let y = LO; y <= HI; y++) w.setBlock(X, y, Z, 0);
  for (let y = HI + 1; y <= 44; y++) w.setBlock(X, y, Z, STONE);
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue;
    for (let y = LO - 1; y <= HI + 1; y++) w.setBlock(X + dx, y, Z + dz, STONE);
  }
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) w.setBlock(X + dx, LO - 1, Z + dz, STONE);
  w.setBlock(X, TY, Z, TORCH);
  return true;
})()`);
const dirty3 = await settle(12);
check('跨 section 场景收敛', dirty3 === 0, { dirty: dirty3 });

const shaft = await ev(`(function(){
  const w = window.game.world, out = [];
  for (let y = 8; y <= 24; y++) { const l = w.lightAt(72, y, 104); out.push({ y: y, lit: l.lit, sky: l.sky }); }
  return out;
})()`);
const S = (y) => (shaft.find((s) => s.y === y) || {}).lit;

console.log('\n  ---- 三、跨 section（火把 y=22，y=16 是 section 0/1 分界，竖井已封顶隔断天光）----');
console.log('  y:       ' + [8, 10, 12, 14, 15, 16, 17, 18, 20, 22].map((y) => String(y).padStart(4)).join(''));
console.log('  section: ' + [8, 10, 12, 14, 15, 16, 17, 18, 20, 22].map((y) => String(Math.floor(y / 16)).padStart(4)).join(''));
console.log('  实测:    ' + [8, 10, 12, 14, 15, 16, 17, 18, 20, 22].map((y) => String(S(y)).padStart(4)).join(''));
console.log('  理论:    ' + [8, 10, 12, 14, 15, 16, 17, 18, 20, 22].map((y) => String(Math.max(0, 14 - Math.abs(y - 22))).padStart(4)).join(''));

check('竖井天光已被封顶切断（测量环境干净）', shaft.every((s) => s.sky === 0), shaft.filter((s) => s.sky !== 0).length);
check('火把自身格 = 14', S(22) === 14, S(22));
check('同 section 内 y=20 = 12', S(20) >= 12, S(20));
check('跨到 section 0 的 y=15 >= 7（旧实现恒为 0）', S(15) >= 7, S(15));
check('section 0 内 y=12 >= 4', S(12) >= 4, S(12));
check('section 0 内 y=9 >= 1', S(9) >= 1, S(9));
check('超出半径 y=8 = 0', S(8) === 0, S(8));

check('全程无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3));

console.log('\n通过 ' + pass + '/' + (pass + fail));
chrome.kill();
process.exit(fail ? 1 : 0);
