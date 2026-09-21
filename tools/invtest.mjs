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

// ---- 5 关界面：光标上提着的东西必须归还背包，且光标贴图要藏起来 ----
const closeReturn = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const planksId = items.ITEM_BY_KEY['planks'].id;
  if (ui.isOpen()) ui.close();
  g.cursor = null;
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
  for (let i=0;i<g.craft2.length;i++) g.craft2[i]=null;
  g.dropped.clear();
  ui.open('inventory');
  g.cursor = inv.makeStack(planksId, 12, 0);
  ui.close();
  const bag = g.inventory.slots.reduce((a,s)=> a + (s && s.id===planksId ? s.count : 0), 0);
  const el = document.getElementById('cursor-stack');
  return { bag, cursorNull: !g.cursor, disp: getComputedStyle(el).display, onGround: g.dropped.list.length };
})()`);
check('关界面：光标物品归还背包', closeReturn.cursorNull === true && closeReturn.bag === 12 && closeReturn.onGround === 0, JSON.stringify(closeReturn));
check('关界面：光标贴图隐藏', closeReturn.disp === 'none', JSON.stringify(closeReturn));

// ---- 6 关界面：背包塞满时归还不了，那组东西要掉到地上而不是凭空消失 ----
const closeDrop = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const dirtId = items.ITEM_BY_KEY['dirt'].id;
  const planksId = items.ITEM_BY_KEY['planks'].id;
  if (ui.isOpen()) ui.close();
  g.cursor = null;
  for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
  for (let i=0;i<g.craft2.length;i++) g.craft2[i]=null;
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=inv.makeStack(dirtId, 64, 0);
  g.dropped.clear();
  ui.open('inventory');
  g.cursor = inv.makeStack(planksId, 12, 0);
  ui.close();
  const entities = g.dropped.list.length;
  const onGround = g.dropped.list.reduce((a,e)=> a + (e.id===planksId ? e.count : 0), 0);
  const bagPlanks = g.inventory.slots.reduce((a,s)=> a + (s && s.id===planksId ? s.count : 0), 0);
  g.dropped.clear();
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  return { entities, onGround, bagPlanks, cursorNull: !g.cursor };
})()`);
check('关界面：背包满时物品掉到地上', closeDrop.cursorNull === true && closeDrop.bagPlanks === 0 && closeDrop.onGround === 12 && closeDrop.entities === 1, JSON.stringify(closeDrop));

// ---- 7 Shift 点击快捷转移：真事件走一遍路由，背包↔热键栏两个方向 ----
const quick = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const planksId = items.ITEM_BY_KEY['planks'].id;
  const dirtId = items.ITEM_BY_KEY['dirt'].id;
  const slotEl = (idx) => [...document.querySelectorAll('#panel .slot')]
    .find(e => e.dataset.area==='inv' && e.dataset.index===String(idx));
  const shiftClick = (idx) => slotEl(idx).dispatchEvent(
    new MouseEvent('mousedown', { bubbles:true, button:0, shiftKey:true }));
  const sumIn = (from, to, id) => { let n=0; for (let i=from;i<=to;i++){ const s=g.inventory.slots[i]; if (s && s.id===id) n+=s.count; } return n; };
  const reset = () => {
    for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
    g.cursor=null; g.inventory.selected=0;
    for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
    for (let i=0;i<g.craft2.length;i++) g.craft2[i]=null;
  };
  if (ui.isOpen()) ui.close();
  ui.open('inventory');

  reset();
  g.inventory.slots[20] = inv.makeStack(planksId, 30, 0);
  shiftClick(20);
  const upHot = sumIn(0, 8, planksId);
  const upSrc = g.inventory.slots[20];
  const upCursor = g.cursor;

  reset();
  g.inventory.slots[3] = inv.makeStack(planksId, 30, 0);
  shiftClick(3);
  const downBag = sumIn(9, inv.INV_SIZE-1, planksId);
  const downSrc = g.inventory.slots[3];

  reset();
  for (let i=9;i<inv.INV_SIZE;i++) g.inventory.slots[i]=inv.makeStack(dirtId, 64, 0);
  g.inventory.slots[3] = inv.makeStack(planksId, 30, 0);
  shiftClick(3);
  const kept = g.inventory.slots[3] ? g.inventory.slots[3].count : -1;
  reset();
  ui.close();
  return { upHot, upSrc: !upSrc, upCursor: upCursor ? upCursor.count : 0, downBag, downSrc: !downSrc, kept };
})()`);
check('Shift 转移：背包格 → 热键栏', quick.upHot === 30 && quick.upSrc === true && quick.upCursor === 0, JSON.stringify(quick));
check('Shift 转移：热键栏格 → 背包', quick.downBag === 30 && quick.downSrc === true, JSON.stringify(quick));
check('Shift 转移：目标区塞不下就原地不动', quick.kept === 30, JSON.stringify(quick));

// ---- 8 Shift 点产物 = 一路合成到材料用完；背包满时一格材料都不吞 ----
const craftAll = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const logId = items.ITEM_BY_KEY['log'].id;
  const planksId = items.ITEM_BY_KEY['planks'].id;
  const dirtId = items.ITEM_BY_KEY['dirt'].id;
  const resultEl = () => [...document.querySelectorAll('#panel .slot')].find(e => e.dataset.area==='result');
  const reset = () => {
    if (ui.isOpen()) ui.close();
    g.cursor=null; g.inventory.selected=0;
    for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
    for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
    for (let i=0;i<g.craft2.length;i++) g.craft2[i]=null;
    g.dropped.clear();
  };
  const sumPlanks = () => g.inventory.slots.reduce((a,s)=> a + (s && s.id===planksId ? s.count : 0), 0);

  reset();
  ui.open('crafting');
  g.craft3[0] = inv.makeStack(logId, 8, 0);
  resultEl().dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button:0, shiftKey:true }));
  const madePlanks = sumPlanks();
  const gridLeft = g.craft3[0] ? g.craft3[0].count : 0;
  const cursorAfter = g.cursor;

  reset();
  ui.open('crafting');
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=inv.makeStack(dirtId, 64, 0);
  g.craft3[0] = inv.makeStack(logId, 8, 0);
  resultEl().dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button:0, shiftKey:true }));
  const fullGrid = g.craft3[0] ? g.craft3[0].count : 0;
  const fullPlanks = sumPlanks();

  reset();
  return { madePlanks, gridLeft, cursorAfter: cursorAfter ? cursorAfter.count : 0, fullGrid, fullPlanks };
})()`);
check('Shift 合成：8 个原木一次做成 32 块木板', craftAll.madePlanks === 32 && craftAll.gridLeft === 0, JSON.stringify(craftAll));
check('Shift 合成：产物直接进背包不经过光标', craftAll.cursorAfter === 0, JSON.stringify(craftAll));
check('Shift 合成：背包满时不吞材料', craftAll.fullGrid === 8 && craftAll.fullPlanks === 0, JSON.stringify(craftAll));

// ---- 9 Q：界面开着丢鼠标悬停格，界面关着丢手持格；Ctrl+Q 丢整组 ----
const dropKey = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const dirtId = items.ITEM_BY_KEY['dirt'].id;
  const press = (ctrl) => window.dispatchEvent(new KeyboardEvent('keydown', { code:'KeyQ', ctrlKey: !!ctrl, bubbles:true }));
  const clearInv = () => { g.cursor=null; for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null; };
  if (ui.isOpen()) ui.close();
  clearInv();
  g.dropped.clear();

  ui.open('inventory');
  g.inventory.selected = 3;
  g.inventory.slots[3] = inv.makeStack(dirtId, 9, 0);
  g.inventory.slots[20] = inv.makeStack(dirtId, 5, 0);
  ui.hover = { area:'inv', index:20 };
  press(false);
  const held = g.inventory.slots[3] ? g.inventory.slots[3].count : -1;
  const hovered = g.inventory.slots[20] ? g.inventory.slots[20].count : -1;
  const droppedOne = g.dropped.list.reduce((a,e)=>a+e.count,0);

  g.dropped.clear();
  g.inventory.slots[20] = inv.makeStack(dirtId, 5, 0);
  ui.hover = { area:'inv', index:20 };
  press(true);
  const hoveredCtrl = g.inventory.slots[20] ? g.inventory.slots[20].count : -1;
  const droppedCtrl = g.dropped.list.reduce((a,e)=>a+e.count,0);

  ui.hover = { area:'result', index:0 };
  g.dropped.clear();
  const blocked = ui.dropHovered(false);

  ui.close();
  clearInv();
  g.dropped.clear();
  g.inventory.selected = 3;
  g.inventory.slots[3] = inv.makeStack(dirtId, 9, 0);
  press(false);
  const closedHeld = g.inventory.slots[3] ? g.inventory.slots[3].count : -1;
  const closedDropped = g.dropped.list.reduce((a,e)=>a+e.count,0);

  clearInv();
  g.dropped.clear();
  return { held, hovered, droppedOne, hoveredCtrl, droppedCtrl, blocked, closedHeld, closedDropped };
})()`);
check('Q：界面开着时丢悬停格（5→4）', dropKey.hovered === 4, JSON.stringify(dropKey));
check('Q：界面开着时不碰手持格（仍是 9）', dropKey.held === 9, JSON.stringify(dropKey));
check('Q：Ctrl+Q 丢整组悬停格', dropKey.hoveredCtrl === -1 && dropKey.droppedCtrl === 5, JSON.stringify(dropKey));
check('Q：产物格不给丢', dropKey.blocked === false, JSON.stringify(dropKey));
check('Q：界面关着时丢手持格（回归）', dropKey.closedHeld === 8 && dropKey.closedDropped === 1, JSON.stringify(dropKey));

// ---- 10 悬停显示物品名 + 耐久 ----
const tip = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const pick = items.ITEM_BY_KEY['iron_pickaxe'];
  if (ui.isOpen()) ui.close();
  g.cursor=null;
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  const el = document.getElementById('slot-tip');
  const vis = () => getComputedStyle(el).display !== 'none';

  ui.open('inventory');
  g.inventory.slots[20] = inv.makeStack(pick.id, 1, 25);
  ui.hover = { area:'inv', index:20 };
  ui.updateTip();
  const text = el.textContent;
  const shown = vis();
  ui.hover = { area:'inv', index:21 };
  ui.updateTip();
  const emptyHidden = !vis();
  const closedHidden = (function(){ ui.close(); return !vis(); })();
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  return { text, shown, emptyHidden, closedHidden, label: pick.label, dur: pick.tool.durability };
})()`);
check('悬停提示：显示物品名', tip.shown && tip.text.indexOf(tip.label) >= 0, JSON.stringify(tip));
check('悬停提示：工具带剩余耐久', tip.text.indexOf('耐久') >= 0 && tip.text.indexOf(String(tip.dur - 25)) >= 0 && tip.text.indexOf(String(tip.dur)) >= 0, JSON.stringify(tip));
check('悬停提示：空格不显示', tip.emptyHidden === true, JSON.stringify(tip));
check('悬停提示：关界面后消失', tip.closedHidden === true, JSON.stringify(tip));

// ---- 11 工具挪位置后耐久不能被重置成全新 ----
const dmgKeep = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const pick = items.ITEM_BY_KEY['iron_pickaxe'];
  const clearInv = () => { g.cursor=null; for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null; };
  if (ui.isOpen()) ui.close();
  clearInv();
  ui.open('inventory');
  g.inventory.slots[20] = inv.makeStack(pick.id, 1, 25);
  [...document.querySelectorAll('#panel .slot')]
    .find(e => e.dataset.area==='inv' && e.dataset.index==='20')
    .dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button:0, shiftKey:true }));
  const moved = g.inventory.slots.slice(0,9).find(s => s && s.id===pick.id);

  clearInv();
  g.cursor = inv.makeStack(pick.id, 1, 33);
  ui.close();
  const bag = g.inventory.slots.find(s => s && s.id===pick.id);

  clearInv();
  return { movedDmg: moved ? moved.dmg : -1, bagDmg: bag ? bag.dmg : -1 };
})()`);
check('工具 Shift 转移后耐久保留（25）', dmgKeep.movedDmg === 25, JSON.stringify(dmgKeep));
check('工具从光标归还后耐久保留（33）', dmgKeep.bagDmg === 33, JSON.stringify(dmgKeep));

// ---- 12 背包界面里要能看出哪一格是手持格 ----
const panelSel = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const ui = g.ui;
  if (ui.isOpen()) ui.close();
  g.cursor = null;
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  ui.open('inventory');
  const marked = () => [...document.querySelectorAll('#panel .slot.sel')].map((e) => e.dataset.area + ':' + e.dataset.index);
  g.inventory.selected = 3; ui.render();
  const at3 = marked();
  g.inventory.selected = 7; ui.render();
  const at7 = marked();
  g.inventory.selected = 0; ui.render();
  ui.close();
  return { at3, at7 };
})()`);
check('背包界面：手持格有高亮', panelSel.at3.length === 1 && panelSel.at3[0] === 'inv:3', JSON.stringify(panelSel));
check('背包界面：换手持格后高亮跟着走', panelSel.at7.length === 1 && panelSel.at7[0] === 'inv:7', JSON.stringify(panelSel));

// ---- 13 滚轮按累计滚动量步进，而不是按事件个数 ----
// 触控板一次轻扫会发十几个小 deltaY。改之前每个事件都算一整格，轻扫一下就绕热键栏一整圈。
const wheel = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const prevLocked = g.locked;
  g.locked = true;
  // 数「跳了几格」而不是「几个事件改变了 selected」：一个事件也可能跳 4 格
  const steps = (n, d) => {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const before = g.inventory.selected;
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: d, bubbles: true }));
      let delta = g.inventory.selected - before;
      if (delta < 0) delta += inv.HOTBAR_SIZE;
      moved += delta;
    }
    return moved;
  };
  g.inventory.selected = 0; const notch = steps(1, 100);
  g.inventory.selected = 0; const flick = steps(12, 12);
  g.inventory.selected = 0; const three = steps(3, 100);
  g.inventory.selected = 0; const huge = steps(1, 1200);
  g.wheelAcc = 0; g.inventory.selected = 0;
  g.locked = prevLocked;
  return { notch, flick, three, huge };
})()`);
check('滚轮：普通鼠标一格 = 切 1 格', wheel.notch === 1, JSON.stringify(wheel));
check('滚轮：触控板轻扫（滚动量 144 分 12 次）= 切 1 格，不是 12 格', wheel.flick === 1, JSON.stringify(wheel));
check('滚轮：连滚三格 = 切 3 格', wheel.three === 3, JSON.stringify(wheel));
check('滚轮：单次超大 delta 最多跳 4 格', wheel.huge === 4, JSON.stringify(wheel));

// ---- 14 拖拽分发：左键把光标上那组按划过的格数均分 ----
const dragLeft = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const planks = items.ITEM_BY_KEY['planks'].id;
  const reset = () => {
    if (ui.isOpen()) ui.close();
    g.cursor = null; g.inventory.selected = 0;
    for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
    for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
    for (let i=0;i<g.craft2.length;i++) g.craft2[i]=null;
    ui.lastClick = null;
    ui.open('inventory');
  };
  const el = (i) => [...document.querySelectorAll('#panel .slot')].find((e) => e.dataset.area==='inv' && e.dataset.index===String(i));
  const down = (i, btn) => el(i).dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button: btn||0 }));
  const move = (i) => el(i).dispatchEvent(new MouseEvent('mousemove', { bubbles:true }));
  const up = (btn) => window.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, button: btn||0 }));
  const counts = (list) => list.map((i) => g.inventory.slots[i] ? g.inventory.slots[i].count : 0);
  const cursor = () => g.cursor ? g.cursor.count : 0;

  // 松手之前不落子（拖拽要等划过哪些格都确定了才知道怎么分）
  reset();
  g.cursor = inv.makeStack(planks, 9, 0);
  down(20);
  const beforeUp = counts([20,21,22]);
  move(21); move(22);
  up();
  const spread9 = counts([20,21,22]);
  const left9 = cursor();

  // 除不尽时余数留在光标上
  reset();
  g.cursor = inv.makeStack(planks, 10, 0);
  down(20); move(21); move(22); up();
  const spread10 = counts([20,21,22]);
  const left10 = cursor();

  // 从一格拿起再拖到别的格：只分给目标格，不把东西放回原处
  reset();
  g.inventory.slots[20] = inv.makeStack(planks, 9, 0);
  down(20);
  const picked = cursor();
  move(21); up();
  const afterPickDrag = counts([20,21]);

  // 光标提着 16 个，按在第 20 格再划过 21/22/23：起点也算一格，4 格各 4 个
  reset();
  g.cursor = inv.makeStack(planks, 16, 0);
  down(20); move(21); move(22); move(23); up();
  const fourSlots = counts([20,21,22,23]);
  const left16 = cursor();

  // 不拖、直接单击：还是原来的一次放完
  reset();
  g.cursor = inv.makeStack(planks, 7, 0);
  down(20); up();
  const plainClick = counts([20]);
  const plainLeft = cursor();

  reset();
  ui.close();
  return { beforeUp, spread9, left9, spread10, left10, picked, afterPickDrag, fourSlots, left16, plainClick, plainLeft };
})()`);
check('左键拖拽：松手之前不落子', dragLeft.beforeUp.join(',') === '0,0,0', JSON.stringify(dragLeft));
check('左键拖拽：9 个分给 3 格 = 3/3/3', dragLeft.spread9.join(',') === '3,3,3' && dragLeft.left9 === 0, JSON.stringify(dragLeft));
check('左键拖拽：10 个分给 3 格 = 3/3/3，余 1 留在光标', dragLeft.spread10.join(',') === '3,3,3' && dragLeft.left10 === 1, JSON.stringify(dragLeft));
check('左键拖拽：拿起后拖走不会放回原格', dragLeft.picked === 9 && dragLeft.afterPickDrag.join(',') === '0,9', JSON.stringify(dragLeft));
check('左键拖拽：光标提着物品时起点也算一格（16 个划 4 格 = 4/4/4/4）', dragLeft.fourSlots.join(',') === '4,4,4,4' && dragLeft.left16 === 0, JSON.stringify(dragLeft));
check('左键单击回归：一次放完', dragLeft.plainClick[0] === 7 && dragLeft.plainLeft === 0, JSON.stringify(dragLeft));

// ---- 15 拖拽分发：右键每格放 1 个 ----
const dragRight = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const planks = items.ITEM_BY_KEY['planks'].id;
  const reset = () => {
    if (ui.isOpen()) ui.close();
    g.cursor = null; g.inventory.selected = 0;
    for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
    for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
    for (let i=0;i<g.craft2.length;i++) g.craft2[i]=null;
    ui.lastClick = null;
    ui.open('inventory');
  };
  const el = (i) => [...document.querySelectorAll('#panel .slot')].find((e) => e.dataset.area==='inv' && e.dataset.index===String(i));
  const down = (i, btn) => el(i).dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button: btn }));
  const move = (i) => el(i).dispatchEvent(new MouseEvent('mousemove', { bubbles:true }));
  const up = (btn) => window.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, button: btn }));
  const counts = (list) => list.map((i) => g.inventory.slots[i] ? g.inventory.slots[i].count : 0);
  const cursor = () => g.cursor ? g.cursor.count : 0;

  reset();
  g.inventory.slots[20] = inv.makeStack(planks, 9, 0);
  down(20, 2);
  const half = cursor();
  const rest = g.inventory.slots[20] ? g.inventory.slots[20].count : 0;
  move(21); move(22); up(2);
  const spread = counts([21,22]);
  const left = cursor();

  // 右键不拖：只放 1 个
  reset();
  g.cursor = inv.makeStack(planks, 7, 0);
  down(20, 2); up(2);
  const oneEach = counts([20]);
  const oneLeft = cursor();

  reset();
  ui.close();
  return { half, rest, spread, left, oneEach, oneLeft };
})()`);
check('右键拖拽：先拿一半（9 → 5 个，原格留 4）', dragRight.half === 5 && dragRight.rest === 4, JSON.stringify(dragRight));
check('右键拖拽：划过的每格放 1 个', dragRight.spread.join(',') === '1,1' && dragRight.left === 3, JSON.stringify(dragRight));
check('右键单击回归：只放 1 个', dragRight.oneEach[0] === 1 && dragRight.oneLeft === 6, JSON.stringify(dragRight));

// ---- 16 双击收拢同种物品 ----
const dblGather = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const planks = items.ITEM_BY_KEY['planks'].id;
  const pick = items.ITEM_BY_KEY['iron_pickaxe'].id;
  const reset = (mode) => {
    if (ui.isOpen()) ui.close();
    g.cursor = null; g.inventory.selected = 0;
    for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
    for (let i=0;i<g.craft3.length;i++) g.craft3[i]=null;
    for (let i=0;i<g.craft2.length;i++) g.craft2[i]=null;
    ui.lastClick = null;
    ui.open(mode || 'inventory');
  };
  const el = (i) => [...document.querySelectorAll('#panel .slot')].find((e) => e.dataset.area==='inv' && e.dataset.index===String(i));
  const click = (i) => {
    el(i).dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, button: 0 }));
  };
  const counts = (list) => list.map((i) => g.inventory.slots[i] ? g.inventory.slots[i].count : 0);

  // 双击第 10 格：第一下拿起 3 个，第二下把 14/20 格的同种物品也收过来
  reset();
  g.inventory.slots[10] = inv.makeStack(planks, 3, 0);
  g.inventory.slots[14] = inv.makeStack(planks, 5, 0);
  g.inventory.slots[20] = inv.makeStack(planks, 2, 0);
  click(10);
  const afterFirst = g.cursor ? g.cursor.count : 0;
  click(10);
  const gathered = g.cursor ? g.cursor.count : 0;
  const emptied = counts([10,14,20]);

  // 收拢也管合成格里的材料（只有工作台界面才有 3x3 格）
  reset('crafting');
  g.inventory.slots[10] = inv.makeStack(planks, 2, 0);
  g.craft3[4] = inv.makeStack(planks, 3, 0);
  click(10); click(10);
  const withCraft = g.cursor ? g.cursor.count : 0;
  const craftLeft = g.craft3[4] ? g.craft3[4].count : 0;

  // 工具不参与收拢（各占一格，叠不起来）——双击等于原地不动，耐久也不能丢
  reset();
  g.inventory.slots[10] = inv.makeStack(pick, 1, 20);
  g.inventory.slots[14] = inv.makeStack(pick, 1, 30);
  click(10); click(10);
  const toolCursor = g.cursor ? g.cursor.count : 0;
  const toolOrigin = g.inventory.slots[10] ? g.inventory.slots[10].count : 0;
  const toolOriginDmg = g.inventory.slots[10] ? g.inventory.slots[10].dmg : -1;
  const toolOther = g.inventory.slots[14] ? g.inventory.slots[14].count : 0;

  reset();
  ui.close();
  return { afterFirst, gathered, emptied, withCraft, craftLeft, toolCursor, toolOrigin, toolOriginDmg, toolOther };
})()`);
check('双击收拢：第一下只拿起这一格（3 个）', dblGather.afterFirst === 3, JSON.stringify(dblGather));
check('双击收拢：全背包同种物品集中到光标（3+5+2=10）', dblGather.gathered === 10 && dblGather.emptied.join(',') === '0,0,0', JSON.stringify(dblGather));
check('双击收拢：合成格里的材料也一起收', dblGather.withCraft === 5 && dblGather.craftLeft === 0, JSON.stringify(dblGather));
check('双击收拢：工具不参与（原地不动、耐久不丢）', dblGather.toolCursor === 0 && dblGather.toolOrigin === 1 && dblGather.toolOriginDmg === 20 && dblGather.toolOther === 1, JSON.stringify(dblGather));

// ---- 17 切换手持物品时显示物品名 ----
const heldName = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  if (g.ui.isOpen()) g.ui.close();
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  const pick = items.ITEM_BY_KEY['iron_pickaxe'];
  const coal = items.ITEM_BY_KEY['coal'];
  g.inventory.slots[2] = inv.makeStack(pick.id, 1, 0);
  g.inventory.slots[4] = inv.makeStack(coal.id, 12, 0);
  g.inventory.selected = 0;
  g.ui.showHint('');
  const el = document.getElementById('item-hint');
  const read = () => ({ text: el.textContent, opacity: el.style.opacity });
  window.dispatchEvent(new KeyboardEvent('keydown', { code:'Digit3', bubbles:true }));
  const at3 = read();
  window.dispatchEvent(new KeyboardEvent('keydown', { code:'Digit5', bubbles:true }));
  const at5 = read();
  window.dispatchEvent(new KeyboardEvent('keydown', { code:'Digit7', bubbles:true }));
  const at7 = read();
  g.inventory.selected = 0;
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  return { at3, at5, at7, pickLabel: pick.label, coalLabel: coal.label, selected: g.inventory.selected };
})()`);
check('切换手持物品：显示物品名', heldName.at3.text === heldName.pickLabel && heldName.at3.opacity === '1', JSON.stringify(heldName));
check('切换手持物品：可叠物品带数量', heldName.at5.text === heldName.coalLabel + ' \u00d712', JSON.stringify(heldName));
check('切换手持物品：切到空格不报名字', heldName.at7.text === heldName.coalLabel + ' \u00d712', JSON.stringify(heldName));

// ---- 18 光标上提着东西时，Q 要丢光标上那组 ----
const dropCursor = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const ui = g.ui;
  const dirtId = items.ITEM_BY_KEY['dirt'].id;
  const press = (ctrl) => window.dispatchEvent(new KeyboardEvent('keydown', { code:'KeyQ', ctrlKey: !!ctrl, bubbles:true }));
  const onGround = () => g.dropped.list.reduce((a,e)=>a+e.count,0);
  const at = (i) => g.inventory.slots[i] ? g.inventory.slots[i].count : -1;
  if (ui.isOpen()) ui.close();
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  g.cursor = null;

  // 光标提着 9 个，鼠标悬停在空格上
  ui.open('inventory');
  g.cursor = inv.makeStack(dirtId, 9, 0);
  g.inventory.slots[21] = inv.makeStack(dirtId, 4, 0);
  ui.hover = { area:'inv', index:22 };
  g.dropped.clear();
  press(false);
  const one = { cursor: g.cursor ? g.cursor.count : 0, ground: onGround(), hovered: at(21) };

  // 悬停格里有东西也一样：先动光标，不许动悬停格
  ui.hover = { area:'inv', index:21 };
  g.dropped.clear();
  press(false);
  const two = { cursor: g.cursor ? g.cursor.count : 0, ground: onGround(), hovered: at(21) };

  // Ctrl+Q 一次把光标上那组丢光
  g.dropped.clear();
  press(true);
  const ctrl = { cursor: g.cursor ? g.cursor.count : 0, ground: onGround(), hovered: at(21) };

  // 光标空着时，还是丢悬停格（老行为，别退化）
  ui.hover = { area:'inv', index:21 };
  g.dropped.clear();
  press(false);
  const fallback = { cursor: g.cursor ? g.cursor.count : 0, ground: onGround(), hovered: at(21) };

  // 光标空着时产物格仍然不给丢
  g.cursor = null;
  ui.hover = { area:'result', index:0 };
  g.dropped.clear();
  const resultBlocked = ui.dropHovered(false);

  ui.close();
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  g.cursor = null;
  g.dropped.clear();
  return { one, two, ctrl, fallback, resultBlocked };
})()`);
check('Q：光标提着东西时丢光标那组（9→8，地上 1）', dropCursor.one.cursor === 8 && dropCursor.one.ground === 1 && dropCursor.one.hovered === 4, JSON.stringify(dropCursor));
check('Q：悬停格有东西也先动光标（8→7，悬停格不动）', dropCursor.two.cursor === 7 && dropCursor.two.ground === 1 && dropCursor.two.hovered === 4, JSON.stringify(dropCursor));
check('Q：Ctrl+Q 把光标那组丢光（地上 7）', dropCursor.ctrl.cursor === 0 && dropCursor.ctrl.ground === 7 && dropCursor.ctrl.hovered === 4, JSON.stringify(dropCursor));
check('Q：光标空着时回到丢悬停格', dropCursor.fallback.cursor === 0 && dropCursor.fallback.ground === 1 && dropCursor.fallback.hovered === 3, JSON.stringify(dropCursor));
check('Q：光标空着时产物格仍不给丢', dropCursor.resultBlocked === false, JSON.stringify(dropCursor));

// ---- 19 系统键自动重复：开关/循环键不能被重复触发，只有 Q 跟手 ----
const keyRepeat = await ev(`(async function(){
  const g = window.game;
  const inv = await import('/js/inventory.js');
  const items = await import('/js/items.js');
  const fire = (code, repeat, ctrl) => window.dispatchEvent(new KeyboardEvent('keydown', { code, repeat: !!repeat, ctrlKey: !!ctrl, bubbles:true }));
  if (g.ui.isOpen()) g.ui.close();
  for (let i=0;i<inv.INV_SIZE;i++) g.inventory.slots[i]=null;
  g.cursor = null;
  g.dropped.clear();

  // 按住 E：真按一次 + 6 次系统重复，界面状态只能翻一次
  fire('KeyE', false);
  const eOpen = g.ui.isOpen();
  for (let i=0;i<6;i++) fire('KeyE', true);
  const eHold = g.ui.isOpen();
  g.ui.close();

  // 按住 R：从 4 只许走到 6，不能一路跳到顶
  if (g.world.renderDistance !== 4) g.setRenderDistance(4);
  const r0 = g.world.renderDistance;
  fire('KeyR', false);
  const r1 = g.world.renderDistance;
  for (let i=0;i<6;i++) fire('KeyR', true);
  const r2 = g.world.renderDistance;

  // 按住 F：飞行开关只能翻一次
  g.player.flying = false;
  fire('KeyF', false);
  const f1 = g.player.flying;
  for (let i=0;i<6;i++) fire('KeyF', true);
  const f2 = g.player.flying;

  // 按住 O：遮蔽开关只能翻一次
  g.setAO(true);
  fire('KeyO', false);
  const o1 = g.world.useAO;
  for (let i=0;i<6;i++) fire('KeyO', true);
  const o2 = g.world.useAO;

  // 按住 Q：真按一次 + 3 次重复 = 丢 4 个（连丢要跟手）
  g.inventory.selected = 0;
  g.inventory.slots[0] = inv.makeStack(items.ITEM_BY_KEY['dirt'].id, 8, 0);
  g.dropped.clear();
  fire('KeyQ', false);
  for (let i=0;i<3;i++) fire('KeyQ', true);
  const qLeft = g.inventory.slots[0] ? g.inventory.slots[0].count : 0;
  const qGround = g.dropped.list.reduce((a,e)=>a+e.count,0);

  g.setAO(true);
  g.setRenderDistance(4);
  g.player.flying = false;
  g.inventory.slots[0] = null;
  g.dropped.clear();
  return { eOpen, eHold, r0, r1, r2, f1, f2, o1, o2, qLeft, qGround };
})()`);
check('按住 E 不会被系统重复开合（开→仍开）', keyRepeat.eOpen === true && keyRepeat.eHold === true, JSON.stringify(keyRepeat));
check('按住 R 只走一步（4→6，不跳顶）', keyRepeat.r0 === 4 && keyRepeat.r1 === 6 && keyRepeat.r2 === 6, JSON.stringify(keyRepeat));
check('按住 F 飞行开关只翻一次', keyRepeat.f1 === true && keyRepeat.f2 === true, JSON.stringify(keyRepeat));
check('按住 O 遮蔽开关只翻一次', keyRepeat.o1 === false && keyRepeat.o2 === false, JSON.stringify(keyRepeat));
check('按住 Q 连丢 4 个（跟手）', keyRepeat.qLeft === 4 && keyRepeat.qGround === 4, JSON.stringify(keyRepeat));

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
