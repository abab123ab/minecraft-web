import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9351;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-layout-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=1400,800', '--user-data-dir=' + userDir
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
  ready = await ev('!!(window.game && window.game.hud && document.getElementById("survival-bar"))');
  if (ready) break;
  await sleep(300);
}
check('游戏初始化完成', ready);
if (!ready) { chrome.kill(); process.exit(1); }

await ev('(function(){ const b=document.getElementById("start-btn"); if(b) b.click(); return true; })()');
await sleep(600);
check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3));

// 把三条 HUD 全部强制显示（满血 + 满甲 + 满饥饿 = 最宽布局），量包围盒是否越出视口
const MEASURE = `(function(){
  const bar = document.getElementById('survival-bar');
  for (const id of ['health-bar','armor-bar','hunger-bar']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }
  const rects = [bar, ...bar.children].map(function(e){ return e.getBoundingClientRect(); });
  const minL = Math.min.apply(null, rects.map(function(r){ return r.left; }));
  const maxR = Math.max.apply(null, rects.map(function(r){ return r.right; }));
  const r0 = bar.getBoundingClientRect();
  const icon = bar.querySelector('.hud-icon');
  return {
    vw: innerWidth,
    barWidth: Math.round(r0.width * 100) / 100,
    barHeight: Math.round(r0.height * 100) / 100,
    rows: Math.round(r0.height / (icon ? icon.getBoundingClientRect().height : 18)),
    iconSize: icon ? Math.round(icon.getBoundingClientRect().width) : 0,
    overflowLeft: Math.round(Math.max(0, -minL) * 100) / 100,
    overflowRight: Math.round(Math.max(0, maxR - innerWidth) * 100) / 100
  };
})()`;

async function setWidth(w) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
}

const widths = [1400, 900, 700, 560, 480, 380];

console.log('\n===== 1. 修复后的容器：任何宽度都不能越出视口 =====');
const after = [];
for (const w of widths) {
  await setWidth(w);
  const m = await ev(MEASURE);
  after.push(m);
  check(`${w}px 视口不溢出`, m.overflowLeft === 0 && m.overflowRight === 0, m);
}

console.log('\n===== 2. 对照实验：把旧规则 width:428px 注回去，应当溢出 =====');
const old = [];
for (const w of widths) {
  await setWidth(w);
  await ev(`(function(){
    let s = document.getElementById('__oldbar');
    if (!s) { s = document.createElement('style'); s.id = '__oldbar'; document.head.appendChild(s); }
    s.textContent = '#survival-bar{width:428px;justify-content:space-between;flex-wrap:nowrap;max-width:none;gap:0;}'
      + '#survival-bar .hud-icon{width:18px;height:18px;}';
    return true;
  })()`);
  await sleep(120);
  const m = await ev(MEASURE);
  old.push(m);
  console.log('    ' + w + 'px → 溢出右 ' + m.overflowRight + 'px  (容器宽 ' + m.barWidth + ')');
}
const oldBroke = old.some((m) => m.overflowRight > 1);
check('旧规则确实会溢出（证明这条测试抓得住这个 bug）', oldBroke, { widths: widths, overflowRight: old.map((m) => m.overflowRight) });

await ev('(function(){ const s=document.getElementById("__oldbar"); if(s) s.remove(); return true; })()');
await sleep(200);

console.log('\n===== 3. 修复后布局形状合理 =====');
check('所有宽度都保持单行（原版观感）', after.every((m) => m.rows === 1), after.map((m) => ({ vw: m.vw, rows: m.rows, barWidth: m.barWidth, icon: m.iconSize })));
check('宽屏 1400px：容器贴合内容 560px', after[0].barWidth === 560, { barWidth: after[0].barWidth });
check('窄屏 380px：靠缩图标保持单行，不换行', after[after.length - 1].rows === 1, after[after.length - 1]);
check('窄屏 380px：容器不超出视口', after[after.length - 1].barWidth <= 380, { barWidth: after[after.length - 1].barWidth });
check('图标尺寸随屏宽递减', after[0].iconSize === 18 && after[after.length - 1].iconSize === 11, after.map((m) => m.iconSize));

console.log('\n===== 4. 快捷栏与 HUD 互不遮挡 =====');
await setWidth(1400);
const clash = await ev(`(function(){
  const bar = document.getElementById('survival-bar').getBoundingClientRect();
  const hot = document.getElementById('hotbar').getBoundingClientRect();
  return { gap: Math.round((hot.top - bar.bottom) * 100) / 100, barBottom: Math.round(bar.bottom), hotTop: Math.round(hot.top) };
})()`);
check('生存条在快捷栏上方且不重叠', clash.gap >= 0, clash);

check('全程无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3));

console.log('\n----------------------------------------------');
console.log('通过 ' + pass + '/' + (pass + fail));
chrome.kill();
process.exit(fail ? 1 : 0);
