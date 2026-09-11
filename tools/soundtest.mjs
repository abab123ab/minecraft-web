import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-soundtest-' + Date.now());

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

let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await ev('!!(window.game && window.game.world && window.game.sfx)');
  if (ready) break;
  await sleep(500);
}
check('游戏初始化完成（含 sfx）', ready);

await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1200);

check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

// ---- A sfx 模块基本结构 ----
const basic = await ev(`(function(){
  const s = window.game.sfx;
  s.resume();
  return {
    hasCtx: !!s.ctx,
    hasMaster: !!s.master,
    state: s.ctx ? s.ctx.state : 'none',
    vol: s.master ? s.master.gain.value : -1,
    muted: s.muted
  };
})()`);
check('resume 后 AudioContext 已创建', basic.hasCtx);
check('master 增益已连接', basic.hasMaster);

// ---- B 每种音效调用不抛异常 ----
const playAll = await ev(`(function(){
  const s = window.game.sfx;
  const errs = [];
  const blk = (cat) => ({ sound: cat });
  try {
    s.breakBlock(blk('stone')); s.breakBlock(blk('wood'));
    s.breakBlock(blk('glass')); s.breakBlock(blk('leaves'));
    s.breakBlock(blk('sand')); s.breakBlock(blk('gravel'));
    s.breakBlock(blk('wool')); s.breakBlock(blk('dirt'));
    s.place(blk('stone')); s.place(blk('wood'));
    s.step('stone'); s.step('wood'); s.step('sand'); s.step('leaves');
    s.land(); s.hurt(); s.eat(); s.pickup();
    s.mobHurt('zombie'); s.mobHurt('pig'); s.mobHurt('creeper');
    s.mobDeath('skeleton'); s.explode(); s.shoot(); s.furnaceReady();
  } catch (e) { errs.push(String(e && e.stack || e)); }
  return { errs };
})()`);
check('所有音效合成调用不抛异常', playAll.errs.length === 0, playAll.errs.join(' | '));

// ---- C 静音切换生效 ----
const mute = await ev(`(function(){
  const s = window.game.sfx;
  const before = s.muted;
  const nowMuted = s.toggleMute();
  const gainMuted = s.master ? s.master.gain.value : -1;
  const back = s.toggleMute();
  const gainBack = s.master ? s.master.gain.value : -1;
  return { before, nowMuted, gainMuted, back, gainBack };
})()`);
check('静音切换改变 muted 标记', mute.nowMuted === true && mute.back === false);
check('静音时 master 增益为 0', mute.gainMuted === 0, 'gain=' + mute.gainMuted);
check('取消静音后 master 增益恢复', mute.gainBack > 0, 'gain=' + mute.gainBack);

// ---- D 真实挖掘触发 break 音效路径不报错 ----
const dig = await ev(`(async function(){
  const g = window.game;
  const mod = await import('/js/blocks.js');
  const bx = Math.floor(g.player.pos.x) + 2;
  const by = Math.floor(g.player.pos.y);
  const bz = Math.floor(g.player.pos.z);
  const stoneId = mod.BLOCK_BY_KEY.stone.id;
  let err = '';
  try {
    g.world.setBlock(bx, by, bz, stoneId);
    g.breakBlock(bx, by, bz);
  } catch (e) { err = String(e && e.stack || e); }
  return { err, gone: g.world.getBlock(bx, by, bz) === 0 };
})()`);
check('真实挖掘（含 break 音效钩子）不报错', dig.err === '', dig.err);
check('挖掘后方块被移除', dig.gone);

// ---- E 跑一段真实帧，确认 step/land/hurt 钩子不报错 ----
await ev(`(async function(){
  const g = window.game;
  g.mobs.clear();
  g.survival.reset();
  g.lastHealth = g.survival.health;
  return true;
})()`);
// 给地面铺一段平路并让玩家走动，触发脚步声
await ev(`(function(){
  const g = window.game;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  for (let dx = -6; dx <= 6; dx++)
    for (let dz = -6; dz <= 6; dz++)
      for (let dy = 1; dy <= 4; dy++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  g.player.pos.y = by;
  g.player.onGround = true;
  g.input.forward = true;
  return true;
})()`);
await sleep(2500);
await ev(`(function(){ window.game.input.forward = false; return true; })()`);
const runState = await ev(`(function(){
  return { fps: window.game.fps, health: window.game.survival.health, stepTimer: window.game.stepTimer };
})()`);
check('走动触发脚步后运行期无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));
check('跑动期帧率 > 20', runState.fps > 20, 'fps=' + runState.fps);

console.log('\n================ 音效系统验证 ================');
let pass = 0;
for (const r of results) {
  console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  if (r.ok) pass++;
}
console.log('----------------------------------------------');
console.log('通过 ' + pass + '/' + results.length);
if (cdp.errors.length) {
  console.log('\nJS 报错:');
  for (const e of cdp.errors.slice(0, 10)) console.log('  ' + e);
}

chrome.kill();
process.exit(pass === results.length ? 0 : 1);
