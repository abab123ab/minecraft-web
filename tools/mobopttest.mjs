import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-mobopt-' + Date.now());

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
      if (msg.id && this.pending.has(msg.id)) { const { resolve } = this.pending.get(msg.id); this.pending.delete(msg.id); resolve(msg); return; }
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
    const id = ++this.id; const payload = { id, method, params: params || {} };
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
for (let i = 0; i < 60; i++) { ready = await ev('!!(window.game && window.game.world && window.game.mobs)'); if (ready) break; await sleep(500); }
check('游戏初始化完成', ready);
await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1000);

// ---- A 静止时呼吸浮动（动作优化）----
const breath = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  const p = g.player.pos;
  const pig = g.mobs.spawn('pig', p.x + 1.5, p.y, p.z);
  pig.onGround = true; pig.vel.set(0,0,0);
  pig.wanderTimer = 9999; pig.pauseTimer = 9999; pig.yaw = 0;
  let maxDev = 0;
  for (let i = 0; i < 120; i++) {
    pig.vel.set(0,0,0); pig.onGround = true; pig.pos.y = p.y;
    g.updateMobs(0.016);
    maxDev = Math.max(maxDev, Math.abs(pig.mesh.position.y - pig.pos.y));
  }
  g.mobs.clear();
  return { maxDev };
})()`);
check('静止生物有呼吸浮动（位置微动）', breath.maxDev > 0.01, 'maxDev=' + breath.maxDev);

// ---- B 近战扑击：lunge 动画 + 音效钩子不报错 ----
const lunge = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  g.survival.reset();
  const p = g.player.pos;
  const z = g.mobs.spawn('zombie', p.x + 1, p.y, p.z);
  z.attackCd = 0;
  g.updateMobs(0.05);
  const r = { lungeT: z.lungeT, sx: z.mesh.scale.x, health: g.survival.health };
  g.mobs.clear();
  return r;
})()`);
check('近战触发扑击 lunge 计时', lunge.lungeT > 0, 'lungeT=' + lunge.lungeT);
check('扑击时模型放大（前冲）', lunge.sx > 1.05, 'sx=' + lunge.sx);
check('近战扑击同时扣血', lunge.health < 20, 'health=' + lunge.health);

// ---- C 受伤挤压 + 受击抖动 ----
const squash = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  const p = g.player.pos;
  const pig = g.mobs.spawn('pig', p.x + 1.5, p.y, p.z);
  pig.hurt(4, null);
  g.updateMobs(0.016);
  const dx = pig.mesh.position.x - pig.pos.x;
  const dz = pig.mesh.position.z - pig.pos.z;
  const r = { sy: pig.mesh.scale.y, sx: pig.mesh.scale.x, flash: pig.hurtFlash, shake: Math.hypot(dx, dz) };
  g.mobs.clear();
  return r;
})()`);
check('受伤时竖直挤压（scale.y<1）', squash.sy < 1, 'sy=' + squash.sy);
check('受伤时水平变宽（scale.x>1）', squash.sx > 1, 'sx=' + squash.sx);
check('受击时位置抖动（击退抖动）', squash.shake > 0.02, 'shake=' + squash.shake);

// ---- D 掉落物：弹出放大 + 散开 ----
const drop = await ev(`(function(){
  const g = window.game;
  g.mobs.clear(); g.dropped.clear();
  const p = g.player.pos;
  const pig = g.mobs.spawn('pig', p.x + 1.5, p.y, p.z);
  pig.hurt(100, { x: 0, z: 0 });
  for (let i = 0; i < 120; i++) g.updateMobs(0.016);
  const list = g.dropped.list;
  const count = list.length;
  const scale0 = count ? list[0].sprite.scale.x : 0;
  for (let i = 0; i < 20; i++) g.dropped.update(0.016, g.player, g.inventory, ()=>{});
  const scaleFull = count ? list[0].sprite.scale.x : 0;
  let scattered = false;
  if (count >= 2) {
    const a = list[0].pos, b = list[1].pos;
    scattered = Math.hypot(a.x-b.x, a.z-b.z) > 0.05;
  }
  g.dropped.clear();
  return { count, scale0, scaleFull, scattered };
})()`);
check('击杀后产生掉落物', drop.count > 0, 'count=' + drop.count);
check('掉落物初始几乎为 0（弹出动画）', drop.scale0 < 0.05, 'scale0=' + drop.scale0);
check('掉落物放大到正常尺寸', drop.scaleFull > 0.3, 'scaleFull=' + drop.scaleFull);
check('多掉落物位置散开', drop.count < 2 || drop.scattered, 'scattered=' + drop.scattered);

// ---- E 环境音不报错（跑几秒让被动生物发声）----
await ev(`(function(){ const g = window.game; g.mobs.clear(); g.isDay = true; return true; })()`);
await sleep(3000);
check('环境音/动画运行期无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 5).join(' | '));

console.log('\n================ 生物动作/音效/掉落物 优化验证 ================');
let pass = 0;
for (const r of results) {
  console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  if (r.ok) pass++;
}
console.log('--------------------------------------------------------------');
console.log('通过 ' + pass + '/' + results.length);
if (cdp.errors.length) { console.log('\nJS 报错:'); for (const e of cdp.errors.slice(0, 10)) console.log('  ' + e); }

chrome.kill();
process.exit(pass === results.length ? 0 : 1);
