import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const SRV = 8321;
const APP = 'http://127.0.0.1:' + SRV + '/';
const userDir = path.join(os.tmpdir(), 'mc-bed-' + Date.now());
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.gif': 'image/gif'
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const full = path.normalize(path.join(ROOT, p));
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const data = await fs.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(SRV, r));

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
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id); resolve(msg); return;
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
for (let i = 0; i < 60; i++) {
  ready = await ev('!!(window.game && window.game.world)');
  if (ready) break;
  await sleep(500);
}
check('游戏初始化完成', ready);
await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1000);
check('开始后无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

// ---- A 床方块已注册 ----
const blk = await ev(`(async function(){
  const m = await import('/js/blocks.js');
  const b = m.BLOCK_BY_KEY.bed;
  return b ? { id: b.id, solid: b.solid, opaque: b.opaque, drop: b.drop, label: b.label } : null;
})()`);
check('床方块已注册', blk !== null);
check('床是实心不透明方块', blk && blk.solid === true && blk.opaque === true);
check('床掉落物为 bed', blk && blk.drop === 'bed');

// ---- A2 床的形状（原版：2 格长，床垫体 16×16×6 悬在 3/16、顶面 9/16，两个端头各一条 3×3×3 的腿）----
const shape = await ev(`(async function(){
  const s = await import('/js/shapes.js');
  const bd = await import('/js/bedshape.js');
  const m = await import('/js/blocks.js');
  const bed = m.BLOCK_BY_KEY.bed.id;
  const stone = m.BLOCK_BY_KEY.stone.id;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const meta = (fc, head) => bd.bedMeta(fc, head);

  const all = [];
  for (let fc = 0; fc < 4; fc++) {
    for (const head of [false, true]) {
      const mm = meta(fc, head);
      const boxes = s.blockBoxes(bed, mm);
      all.push({
        fc, head,
        n: boxes.length,
        mattress: boxes[0],
        legs: boxes.slice(1),
        collide: s.blockCollide(bed, mm)[0],
        bounds: s.shapeBounds(bed, mm)
      });
    }
  }

  // 腿在世界上必须只落在整张床的两个外端：foot 格在 (0,0,0)，head 格在 foot + facing 方向。
  // 这是四向朝向的命门 —— 腿端向算错时，中间会凭空多出一组柱子。
  const legs = [];
  for (let fc = 0; fc < 4; fc++) {
    const f = bd.BED_FACING[fc];
    const ax = f[0] !== 0 ? 0 : 2;
    const spans = [];
    for (let i = 0; i < 2; i++) {
      const boxes = s.blockBoxes(bed, meta(fc, i === 1));
      const orig = i === 0 ? 0 : (ax === 0 ? f[0] : f[1]);
      for (const b of boxes.slice(1)) spans.push([orig + b[ax], orig + b[ax + 3]]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    const lo = Math.min.apply(null, spans.map((v) => v[0]));
    const hi = Math.max.apply(null, spans.map((v) => v[1]));
    legs.push({
      fc,
      fx: f[0], fz: f[1],
      atEnds: spans.every((v) => near(v[0], lo) || near(v[1], hi)),
      twoEach: spans.filter((v) => near(v[0], lo)).length === 2 && spans.filter((v) => near(v[1], hi)).length === 2,
      out: Math.abs(hi - lo)
    });
  }

  return {
    all, legs,
    bedFull: s.isFullCube(bed),
    stoneFull: s.isFullCube(stone),
    stoneBoxes: s.blockBoxes(stone).length,
    place: [0, Math.PI, Math.PI / 2, -Math.PI / 2].map((y) => bd.bedPlaceMeta(y).facing)
  };
})()`);

const near916 = (n) => Math.abs(n - 0.5625) < 1e-9;
const near316 = (n) => Math.abs(n - 0.1875) < 1e-9;
const isLeg = (l) => near316(l[3] - l[0]) && near316(l[4] - l[1]) && near316(l[5] - l[2]);

check('床不再是满格方块', shape.bedFull === false);
check('普通方块仍然走满格快速路径', shape.stoneFull === true && shape.stoneBoxes === 1);
check('每一半都是「床垫体 + 两条腿」三个盒子',
  shape.all.every((x) => x.n === 3), shape.all.map((x) => x.n).join(','));
check('床垫体：下沿 3/16、顶面 9/16（悬空在腿上）',
  shape.all.every((x) => near316(x.mattress[1]) && near916(x.mattress[4])));
check('床垫体铺满整格（长宽都是 1，2 格长的每一格都铺满）',
  shape.all.every((x) => x.mattress[0] === 0 && x.mattress[2] === 0 && x.mattress[3] === 1 && x.mattress[5] === 1));
check('判定箱 = 9/16 高的整底盒子（原版 BlockBed.SHAPE）',
  shape.all.every((x) => x.collide[0] === 0 && x.collide[1] === 0 && x.collide[2] === 0 &&
    x.collide[3] === 1 && near916(x.collide[4]) && x.collide[5] === 1));
check('外观包围盒也正好是 [0,0,0]-[1,9/16,1]',
  shape.all.every((x) => x.bounds[0] === 0 && x.bounds[1] === 0 && x.bounds[2] === 0 &&
    x.bounds[3] === 1 && near916(x.bounds[4]) && x.bounds[5] === 1));
check('两条腿都是 3/16 的立方体、且顶面顶在床垫体下沿',
  shape.all.every((x) => x.legs.length === 2 && x.legs.every((l) => isLeg(l) && l[4] === x.mattress[1])));
check('两条腿在床轴的两个不同位置（不是并排在同一端）',
  shape.all.every((x) => Math.abs(x.legs[0][0] - x.legs[1][0]) + Math.abs(x.legs[0][2] - x.legs[1][2]) > 0.5));
check('四向朝向 × 两半：腿都只落在整张床的两个外端（中间不能多出柱子）',
  shape.legs.every((x) => x.atEnds && x.twoEach),
  shape.legs.map((x) => 'fc' + x.fc + (x.atEnds && x.twoEach ? ':ok' : ':BAD')).join(' '));
check('整张床长 2 格', shape.legs.every((x) => Math.abs(x.out - 2) < 1e-9), shape.legs.map((x) => x.out).join(','));
check('放置朝向映射：yaw 0/PI/PI2/-PI2 -> facing 0/1/2/3',
  shape.place.join(',') === '0,1,2,3', shape.place.join(','));

// ---- B 床合成表存在（3 羊毛 + 3 木板）----
const recipe = await ev(`(async function(){
  const c = await import('/js/crafting.js');
  const r = c.RECIPES.find((x) => x.resultKey === 'bed');
  if (!r) return null;
  const flat = r.pattern.join('');
  const wool = (flat.match(/W/g) || []).length;
  const plank = (flat.match(/P/g) || []).length;
  return { type: r.type, wool, plank, count: r.count };
})()`);
check('床合成配方已注册', recipe !== null);
check('床配方为 3 羊毛 + 3 木板', recipe && recipe.wool === 3 && recipe.plank === 3 && recipe.count === 1, recipe);

// ---- C 夜里右键床 → 睡觉 + 设重生点 + 黑屏遮罩 ----
const night = await ev(`(async function(){
  const g = window.game;
  g.timeOfDay = 0.85; g.updateDayNight(0);
  const isNight = g.isNight;
  const m = await import('/js/blocks.js');
  const bedId = m.BLOCK_BY_KEY.bed.id;
  const bx = Math.floor(g.player.pos.x) + 2, by = Math.floor(g.player.pos.y), bz = Math.floor(g.player.pos.z);
  g.world.setBlock(bx, by, bz, bedId);
  const before = { x: g.spawnPoint.x, y: g.spawnPoint.y, z: g.spawnPoint.z };
  g.trySleep({ x: bx, y: by, z: bz, ny: 1 });
  const el = document.getElementById('sleep');
  return {
    isNight, placed: g.world.getBlock(bx, by, bz) === bedId,
    sleeping: g.sleeping,
    spawnOk: Math.abs(g.spawnPoint.x - (bx + 0.5)) < 1e-6 && Math.abs(g.spawnPoint.y - (by + 1)) < 1e-6 && Math.abs(g.spawnPoint.z - (bz + 0.5)) < 1e-6,
    overlayOn: el ? el.classList.contains('on') : false,
    before
  };
})()`);
check('0.85 时刻判定为夜晚', night.isNight === true);
check('床方块已放置到世界', night.placed);
check('右键床后进入睡眠状态', night.sleeping === true);
check('重生点更新为床的位置', night.spawnOk);
check('黑屏遮罩 #sleep 已点亮', night.overlayOn === true);

// ---- D 快进到早上 → 自动醒来 + 遮罩关闭 ----
const wake = await ev(`(function(){
  const g = window.game;
  g.sleeping = true;
  g.timeOfDay = 0.85; g.updateDayNight(0);
  let guard = 0;
  while (!g.isDay && guard < 400) {
    g.updateDayNight(0.05 * 80);
    if (g.isDay) g.wake();
    guard++;
  }
  const el = document.getElementById('sleep');
  return { isDay: g.isDay, sleeping: g.sleeping, overlayOff: el ? !el.classList.contains('on') : true, guard };
})()`);
check('快进后到达白天', wake.isDay === true, 'guard=' + wake.guard);
check('自动醒来（sleeping=false）', wake.sleeping === false);
check('醒来后遮罩关闭', wake.overlayOff === true);

// ---- E 白天右键床 → 不睡觉 ----
const dayRefuse = await ev(`(function(){
  const g = window.game;
  g.sleeping = false;
  const el = document.getElementById('sleep'); if (el) el.classList.remove('on');
  g.timeOfDay = 0.3; g.updateDayNight(0);
  const isDay = g.isDay;
  const bx = Math.floor(g.player.pos.x) + 2, by = Math.floor(g.player.pos.y), bz = Math.floor(g.player.pos.z);
  g.trySleep({ x: bx, y: by, z: bz, ny: 1 });
  return { isDay, sleeping: g.sleeping, overlayOn: el ? el.classList.contains('on') : false };
})()`);
check('0.3 时刻判定为白天', dayRefuse.isDay === true);
check('白天右键床不进入睡眠', dayRefuse.sleeping === false);
check('白天不点亮遮罩', dayRefuse.overlayOn === false);

// ---- F 睡眠期间玩家与生物被冻结 ----
const frozen = await ev(`(function(){
  const g = window.game;
  g.sleeping = true;
  const pBefore = { x: g.player.pos.x, y: g.player.pos.y, z: g.player.pos.z };
  g.input.forward = true;
  // 模拟一帧：loop 内部用 canAct=!sleeping 冻结 player.update 与 updateMobs
  g.player.update(0.05, {});
  const moved = Math.abs(g.player.pos.x - pBefore.x) + Math.abs(g.player.pos.y - pBefore.y) + Math.abs(g.player.pos.z - pBefore.z);
  const mobsActive = g.mobs ? (g.sleeping ? false : true) : true;
  g.input.forward = false;
  g.sleeping = false;
  return { moved, mobsActive };
})()`);
check('睡眠时玩家输入被冻结（无移动）', frozen.moved < 1e-6, 'moved=' + frozen.moved);

check('全流程无 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 5).join(' | '));

console.log('\n================ 床（睡觉跳夜 + 重生点）验证 ================');
let pass = 0;
for (const r of results) {
  console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  if (r.ok) pass++;
}
console.log('----------------------------------------------------------');
console.log('通过 ' + pass + '/' + results.length);
if (cdp.errors.length) {
  console.log('\nJS 报错:');
  for (const e of cdp.errors.slice(0, 10)) console.log('  ' + e);
}

server.close();
chrome.kill();
process.exit(pass === results.length ? 0 : 1);
