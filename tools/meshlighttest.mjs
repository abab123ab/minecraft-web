import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9352;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-meshlight-' + Date.now());

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

// 公共工具：网格顶点色统计 + 取一个全新区块的地表 section
const HELPERS = `
  const stats = function(m){
    if (!m) return null;
    const a = m.geometry.attributes.color.array;
    var sum = 0, n = a.length / 3, mx = -1, mn = 9, sums = {};
    for (var i = 0; i < a.length; i += 3) {
      var s = a[i] + a[i+1] + a[i+2];
      sum += s; if (s > mx) mx = s; if (s < mn) mn = s;
      var k = Math.round(s * 1000) / 1000;
      sums[k] = 1;
    }
    return { verts: n, avg: sum / a.length, maxRGBsum: mx, minRGBsum: mn, distinct: Object.keys(sums).length };
  };
  const siOf = function(ch){
    var maxH = 0;
    for (var i = 0; i < 256; i++) if (ch.surface[i] > maxH) maxH = ch.surface[i];
    return { maxH: maxH, si: Math.floor(maxH / 16) };
  };
`;

console.log('\n===== 1. 根因证据：建面时读到的光，是实心方块自己的还是旁边空气的？ =====');
const evidence = await ev(`(function(){
  ${HELPERS}
  const w = window.game.world;
  const ch = w.ensureChunk(30, 30);
  const { maxH, si } = siOf(ch);
  w.buildSection(ch, si);
  const data = ch.data, sky = ch.skyLight, lit = ch.blockLight;
  const idx = function(x, y, z){ return x + 16 * (z + 16 * y); };

  var solid = 0, solidSkyGt0 = 0, solidLitGt0 = 0;
  var air = 0, airSkyFull = 0, airLitGt0 = 0;
  for (var y = si * 16; y < si * 16 + 16; y++) {
    for (var z = 0; z < 16; z++) for (var x = 0; x < 16; x++) {
      var i = idx(x, y, z);
      if (data[i] === 0) { air++; if (sky[i] === 15) airSkyFull++; if (lit[i] > 0) airLitGt0++; }
      else { solid++; if (sky[i] > 0) solidSkyGt0++; if (lit[i] > 0) solidLitGt0++; }
    }
  }
  const topY = maxH;
  const selfSky = sky[idx(8, topY, 8)];
  const aboveSky = sky[idx(8, Math.min(79, topY + 1), 8)];
  return {
    maxH, si,
    实心块总数: solid, 实心块自身skyLight大于0: solidSkyGt0, 实心块自身blockLight大于0: solidLitGt0,
    空气块总数: air, 空气块skyLight等于15: airSkyFull, 空气块blockLight大于0: airLitGt0,
    地表块自身skyLight: selfSky, 地表上方空气skyLight: aboveSky,
    网格: stats(ch.secs[si].o)
  };
})()`);
console.log('    地表 y=' + evidence.maxH + ' 所在 section si=' + evidence.si);
console.log('    实心块 ' + evidence.实心块总数 + ' 个：自身 skyLight>0 的有 ' + evidence.实心块自身skyLight大于0 +
  ' 个，自身 blockLight>0 的有 ' + evidence.实心块自身blockLight大于0 + ' 个');
console.log('    空气块 ' + evidence.空气块总数 + ' 个：skyLight=15 的有 ' + evidence.空气块skyLight等于15 +
  ' 个，blockLight>0 的有 ' + evidence.空气块blockLight大于0 + ' 个');
console.log('    地表块 (8,' + evidence.maxH + ',8) 自身 skyLight = ' + evidence.地表块自身skyLight +
  ' ，其上方 (8,' + (evidence.maxH + 1) + ',8) 空气 skyLight = ' + evidence.地表上方空气skyLight);
console.log('    网格顶点色：' + JSON.stringify(evidence.网格));

check('实心方块自身的 skyLight 恒为 0（光照不会写进不透明方块内部）',
  evidence.实心块自身skyLight大于0 === 0, { 实心块总数: evidence.实心块总数, skyLight大于0: evidence.实心块自身skyLight大于0 });
check('空气方块确实有 skyLight=15（光只存在于空气里）',
  evidence.空气块skyLight等于15 > 0, { 空气块总数: evidence.空气块总数, skyLight等于15: evidence.空气块skyLight等于15 });
check('地表块自身 skyLight=0 但上方空气 skyLight=15（两个候选光源差异明确）',
  evidence.地表块自身skyLight === 0 && evidence.地表上方空气skyLight === 15, evidence);

console.log('\n===== 2. 网格亮度是否被钉死在 0.30（无光照变化） =====');
const gm = evidence.网格;
console.log('    顶点数 ' + gm.verts + ' · 平均 ' + gm.avg.toFixed(4) +
  ' · r+g+b 最小 ' + gm.minRGBsum.toFixed(4) + ' / 最大 ' + gm.maxRGBsum.toFixed(4) +
  ' · 不同亮度档位 ' + gm.distinct + ' 个');
check('r+g+b 最大值应接近 3.0（露天受光面 → lv=1），而不是被钉在 0.9',
  gm.maxRGBsum > 2.0, { maxRGBsum: gm.maxRGBsum });
check('网格里应出现多种亮度档位（光照在起变化）',
  gm.distinct > 20, { distinct: gm.distinct });

console.log('\n===== 3. 全新区块：首次建面 vs 光照算完后重建 =====');
const rebuild = await ev(`(function(){
  ${HELPERS}
  const w = window.game.world;
  const ch = w.ensureChunk(32, 32);
  const { si } = siOf(ch);
  w.buildSection(ch, si);
  const a = stats(ch.secs[si].o);
  w.buildSection(ch, si);
  const b = stats(ch.secs[si].o);
  w.buildSection(ch, si);
  const c = stats(ch.secs[si].o);
  return { si, a, b, c };
})()`);
console.log('    第 1/2/3 次建面的 r+g+b 最大值: ' + rebuild.a.maxRGBsum.toFixed(3) + ' → ' +
  rebuild.b.maxRGBsum.toFixed(3) + ' → ' + rebuild.c.maxRGBsum.toFixed(3));
check('第 1 次建面就已收敛（无需重建才正确）',
  Math.abs(rebuild.a.maxRGBsum - rebuild.c.maxRGBsum) < 0.05, rebuild);
check('第 2、3 次建面结果稳定', Math.abs(rebuild.b.maxRGBsum - rebuild.c.maxRGBsum) < 0.05, rebuild);

console.log('\n===== 4. 实机已加载区块：网格亮度是否与重建一致 =====');
const live = await ev(`(function(){
  ${HELPERS}
  const w = window.game.world;
  const out = [];
  for (const ch of w.chunks.values()) {
    const { si } = siOf(ch);
    const m = ch.secs[si].o;
    if (!m) continue;
    const before = stats(m).maxRGBsum;
    w.buildSection(ch, si);
    const after = stats(ch.secs[si].o).maxRGBsum;
    out.push({ cx: ch.cx, cz: ch.cz, si, before, after });
  }
  return out;
})()`);
const stale = live.filter((r) => Math.abs(r.after - r.before) > 0.05);
const maxes = live.map((r) => r.before).sort((a, b) => a - b);
console.log('    采样 ' + live.length + ' 个已加载区块，重建后亮度变化 >0.05 的有 ' + stale.length + ' 个');
if (maxes.length) {
  console.log('    建面 r+g+b 最大值分布: 最小 ' + maxes[0].toFixed(3) + ' / 中位 ' +
    maxes[Math.floor(maxes.length / 2)].toFixed(3) + ' / 最大 ' + maxes[maxes.length - 1].toFixed(3));
}
check('实机已加载区块的网格亮度都正常（有亮暗层次）',
  maxes.length > 0 && maxes[Math.floor(maxes.length / 2)] > 2.0, { 中位最大值: maxes[Math.floor(maxes.length / 2)] });

check('全程无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3));

console.log('\n----------------------------------------------');
console.log('通过 ' + pass + '/' + (pass + fail));
chrome.kill();
process.exit(fail ? 1 : 0);
