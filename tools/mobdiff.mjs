import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(buf) {
  let off = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h, depth, color } = ihdr;
  const bits = { 0: depth, 2: depth * 3, 3: depth, 4: depth * 2, 6: depth * 4 }[color];
  const bpp = Math.max(1, Math.ceil(bits / 8));
  const stride = Math.ceil((w * bits) / 8);
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  const px = (x, y) => {
    const i = y * stride + x * bpp;
    if (color === 6) return [out[i], out[i + 1], out[i + 2]];
    if (color === 2) return [out[i], out[i + 1], out[i + 2]];
    if (color === 0) return [out[i], out[i], out[i]];
    if (color === 4) return [out[i], out[i], out[i]];
    const bi = y * stride + (depth === 8 ? x : (x >> 1));
    const idx = depth === 8 ? out[bi] : ((x & 1) ? (out[bi] & 0x0f) : (out[bi] >> 4));
    return [plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2]];
  };
  return { w, h, px };
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const APP = 'http://127.0.0.1:8321/';
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=1024,640', '--user-data-dir=' + path.join(os.tmpdir(), 'mc-diff-' + Date.now())
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
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.session = null;
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
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
async function ev(e) {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
for (let i = 0; i < 60; i++) { if (await ev('!!(window.game && window.game.mobs)')) break; await sleep(500); }
await ev(`document.getElementById('start-btn').click()`);
await sleep(1200);

await ev(`(function(){
  const g = window.game;
  g.mobs.clear(); g.mobs.spawnTimer = 999; g.isDay = true; g.player.pitch = 0;
  const p = g.player.pos;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  for (let dx = -8; dx <= 8; dx++)
    for (let dz = -3; dz <= 9; dz++)
      for (let dy = 1; dy <= 6; dy++)
        g.world.setBlock(bx + dx, by + dy, bz + dz, 0);
  return true;
})()`);
await sleep(1500);

async function shot() {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(s.result.data, 'base64');
}
const base = decodePNG(await shot());

await ev(`(function(){
  const g = window.game;
  const p = g.player.pos;
  const dir = g.lookDir();
  const hl = Math.hypot(dir.x, dir.z) || 1;
  const fx = dir.x / hl, fz = dir.z / hl, rx = -fz, rz = fx;
  const types = ['pig','cow','chicken','sheep','zombie','skeleton','creeper'];
  for (let i = 0; i < types.length; i++) {
    const off = (i - 3) * 0.95;
    g.mobs.spawn(types[i], p.x + fx * 3.5 + rx * off, p.y, p.z + fz * 3.5 + rz * off);
  }
  for (let i = 0; i < 8; i++) { g.mobs.spawnTimer = 999; g.updateMobs(0.016); }
  return g.mobs.count();
})()`);
await sleep(800);
const withMob = decodePNG(await shot());
fs.mkdirSync('screenshots', { recursive: true });
fs.writeFileSync('screenshots/mobs-final.png', await shot());

let diff = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
const buckets = {};
for (let y = 0; y < base.h; y++) {
  for (let x = 0; x < base.w; x++) {
    const a = base.px(x, y), b = withMob.px(x, y);
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 40) continue;
    diff++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    const [r, g, bl] = b;
    let k;
    if (r > 180 && g < 175 && r - g > 40) k = '粉(猪)';
    else if (g > r + 25 && g > bl + 25) k = '绿(苦力怕)';
    else if (bl > r + 25 && g > r + 15) k = '青(僵尸衣)';
    else if (r < 150 && r > g && g > bl && r - bl > 25) k = '棕(牛)';
    else if (Math.abs(r - g) < 18 && Math.abs(g - bl) < 18 && r > 185) k = '白(鸡/羊/骷髅)';
    else k = '其他';
    buckets[k] = (buckets[k] || 0) + 1;
  }
}

console.log('\n=========== 生物渲染差分验证 ===========');
console.log('画面 ' + base.w + 'x' + base.h + '   变化像素 ' + diff);
console.log('变化区域 x ' + minX + '..' + maxX + '   y ' + minY + '..' + maxY);
console.log('\n变化像素配色分布：');
for (const k of Object.keys(buckets).sort((a, b2) => buckets[b2] - buckets[a])) {
  console.log('  ' + k.padEnd(16) + buckets[k]);
}
console.log('\n截图: mobs-final.png');

chrome.kill();
process.exit(0);
