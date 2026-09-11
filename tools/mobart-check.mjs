import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-art-' + Date.now());

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
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push('CON: ' + m.params.args.map((a) => a.value || '').join(' '));
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

async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}

for (let i = 0; i < 60; i++) { if (await ev('!!(window.game && window.game.mobs)')) break; await sleep(500); }
await ev(`document.getElementById('start-btn').click()`);
await sleep(1200);

// 1. 逐个读出合成后的立绘 canvas 像素统计
const art = await ev(`(function(){
  const g = window.game;
  const out = {};
  const types = ['pig','cow','chicken','sheep','zombie','skeleton','creeper'];
  for (const t of types) {
    g.mobs.clear();
    const m = g.mobs.spawn(t, g.player.pos.x, g.player.pos.y, g.player.pos.z);
    const canvas = m.mesh.material.map.image;
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0, tot = 0, r = 0, gg = 0, b = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      tot++;
      if (d[i+3] > 128) {
        n++; r += d[i]; gg += d[i+1]; b += d[i+2];
        if ((d[i] + d[i+1] + d[i+2]) / 3 < 70) dark++;
      }
    }
    const rows = [];
    for (let yy = 0; yy < canvas.height; yy++) {
      let line = '';
      for (let xx = 0; xx < canvas.width; xx++) {
        const i = (yy * canvas.width + xx) * 4;
        if (d[i + 3] <= 128) { line += ' '; continue; }
        const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
        line += lum < 60 ? '@' : lum < 100 ? '#' : lum < 145 ? '+' : lum < 190 ? '-' : '.';
      }
      rows.push(line);
    }
    out[t] = {
      w: canvas.width, h: canvas.height,
      fill: +(n / tot).toFixed(2),
      rgb: n ? [Math.round(r / n), Math.round(gg / n), Math.round(b / n)] : null,
      darkPct: n ? +(dark / n * 100).toFixed(1) : 0,
      rows
    };
  }
  g.mobs.clear();
  return out;
})()`);

// 2. A/B 对照：同一视角下有 mob 与无 mob 的屏幕像素差
async function shot() {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(s.result.data, 'base64');
}

const visible = await ev(`(function(){
  const g = window.game;
  g.mobs.clear();
  const dir = g.lookDir();
  const hl = Math.hypot(dir.x, dir.z) || 1;
  const fx = dir.x / hl, fz = dir.z / hl;
  g.player.pitch = 0;
  const p = g.player.pos;
  const m = g.mobs.spawn('creeper', p.x + fx * 3.5, p.y, p.z + fz * 3.5);
  for (let i = 0; i < 5; i++) { g.mobs.spawnTimer = 999; g.updateMobs(0.016); }
  return { mobY: m.pos.y, playerY: p.y };
})()`);
await sleep(500);
const withMob = await shot();
await ev(`window.game.mobs.clear();`);
await sleep(500);
const noMob = await shot();

// 解码两张截图做差分
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');
fs.mkdirSync('screenshots', { recursive: true });
fs.writeFileSync('screenshots/art-with.png', withMob);
fs.writeFileSync('screenshots/art-without.png', noMob);

console.log('\n=========== 生物立绘检查 ===========');
console.log('类型      尺寸      填充   平均RGB            暗像素%');
const EXPECT = {
  pig: '粉', cow: '棕', chicken: '白', sheep: '米白',
  zombie: '青衣+绿头', skeleton: '骨白', creeper: '绿'
};
for (const k in art) {
  const a = art[k];
  console.log('\n--- ' + k + '  ' + a.w + 'x' + a.h + '  填充' + a.fill + '  平均' + a.rgb.join(',') + '  暗' + a.darkPct + '%  期望:' + EXPECT[k] + ' ---');
  for (const r of a.rows) console.log('  |' + r + '|');
}
console.log('\ncreeper 放置在 y=' + visible.mobY.toFixed(1) + ' 玩家 y=' + visible.playerY.toFixed(1));
console.log('截图已存 art-with.png / art-without.png');
if (cdp.errors.length) { console.log('\n报错:'); cdp.errors.slice(0, 5).forEach((e) => console.log('  ' + e)); }

chrome.kill();
process.exit(0);
