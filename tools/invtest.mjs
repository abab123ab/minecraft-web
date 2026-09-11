import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9345;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-inv-' + Date.now());

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
const targetId = created.result.targetId;
const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
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
  ready = await ev('!!(window.game && window.game.world && window.game.ui)');
  if (ready) break;
  await sleep(500);
}
check('游戏初始化完成', ready);
await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1500);
check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

// ---- 1 物品贴图跟随光标：拿起物品时光标堆叠显示 ----
const show = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  g.cursor = inv.makeStack(items.ITEM_BY_KEY['planks'].id, 5, 0);
  g.ui.render();
  const el = document.getElementById('cursor-stack');
  const disp = getComputedStyle(el).display;
  const hasCanvas = !!el.querySelector('canvas');
  g.cursor = null; g.ui.render();
  return { disp, hasCanvas };
})()`);
check('拿起物品时光标贴图显示（display 非 none 且有 canvas）', show.disp !== 'none' && show.hasCanvas, JSON.stringify(show));

// ---- 2 合成 Shift 点击：把光标物品分发填充到空格 ----
const fill = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  ui.open('crafting');
  for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
  g.cursor = inv.makeStack(items.ITEM_BY_KEY['planks'].id, 10, 0);
  g.craft3[0] = inv.makeStack(items.ITEM_BY_KEY['planks'].id, 1, 0); // 预占 1 格
  ui.interact('craft', 4, false, true); // shift+左键点空格
  let filled=0; for (let i=0;i<g.craft3.length;i++) if (g.craft3[i]) filled++;
  const occ0 = g.craft3[0].count;
  const curLeft = g.cursor ? g.cursor.count : 0;
  const cursorNull = !g.cursor;
  for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
  g.cursor=null; ui.close();
  return { filled, occ0, curLeft, cursorNull, total: g.craft3.length };
})()`);
check('Shift 填充：空格全被填充', fill.filled === fill.total, JSON.stringify(fill));
check('Shift 填充：已占格不被覆盖', fill.occ0 === 1, JSON.stringify(fill));
check('Shift 填充：光标剩余正确（10-8=2）', fill.cursorNull === false && fill.curLeft === 2, JSON.stringify(fill));

// ---- 3 合成 Shift 填充在物品不足时正确停止 ----
const exhaust = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  ui.open('crafting');
  for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
  g.cursor = inv.makeStack(items.ITEM_BY_KEY['planks'].id, 3, 0); // 只有 3 个
  ui.interact('craft', 0, false, true);
  let filled=0; for (let i=0;i<g.craft3.length;i++) if (g.craft3[i]) filled++;
  const cursorNull = !g.cursor;
  for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
  g.cursor=null; ui.close();
  return { filled, cursorNull };
})()`);
check('Shift 填充：物品不足时只填 3 格且光标清空', exhaust.filled === 3 && exhaust.cursorNull === true, JSON.stringify(exhaust));

// ---- 4 回归：非 Shift 左键把整组放进单个格 ----
const place = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  ui.open('crafting');
  for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
  g.cursor = inv.makeStack(items.ITEM_BY_KEY['planks'].id, 7, 0);
  ui.interact('craft', 2, false, false); // 左键点空格2
  const slot2 = g.craft3[2] ? g.craft3[2].count : 0;
  const cursorNull = !g.cursor;
  for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
  g.cursor=null; ui.close();
  return { slot2, cursorNull };
})()`);
check('非 Shift 左键：整组放进单格', place.slot2 === 7 && place.cursorNull === true, JSON.stringify(place));

console.log('\n================ 库存/合成交互验证 ================');
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
