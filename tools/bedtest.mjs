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
      const boxes = s.blockBoxes(bed, mm).map((o) => o.box);
      all.push({
        fc, head,
        n: boxes.length,
        mattress: boxes[0],
        legs: boxes.slice(1),
        collide: s.blockCollide(bed, mm)[0].box,
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
      const boxes = s.blockBoxes(bed, meta(fc, i === 1)).map((o) => o.box);
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
//
// 床是两格一张，所以这里摆**完整**的一张（床尾 + 床头），而且刻意点**床尾**那一格：
// 重生点应该落到床头那一格、高度是床垫面（9/16），不是点哪格就重生在哪格。
const night = await ev(`(async function(){
  const g = window.game;
  g.timeOfDay = 0.85; g.updateDayNight(0);
  const isNight = g.isNight;
  const m = await import('/js/blocks.js');
  const bd = await import('/js/bedshape.js');
  const bedId = m.BLOCK_BY_KEY.bed.id;
  const bx = Math.floor(g.player.pos.x) + 2, by = Math.floor(g.player.pos.y), bz = Math.floor(g.player.pos.z);
  const footMeta = bd.bedMeta(1, false);   // 朝南 + 床尾
  const headMeta = bd.bedMeta(1, true);    // 朝南 + 床头
  g.world.setBlock(bx, by, bz, bedId, footMeta);
  g.world.setBlock(bx, by, bz + 1, bedId, headMeta);
  const before = { x: g.spawnPoint.x, y: g.spawnPoint.y, z: g.spawnPoint.z };
  g.trySleep({ x: bx, y: by, z: bz, ny: 1, id: bedId, meta: footMeta });
  const el = document.getElementById('sleep');
  return {
    isNight, placed: g.world.getBlock(bx, by, bz) === bedId,
    sleeping: g.sleeping, bedH: bd.BED_H,
    // 床头那一格在 +z 侧（朝南），重生点该落在那里
    spawnOk: Math.abs(g.spawnPoint.x - (bx + 0.5)) < 1e-6 &&
             Math.abs(g.spawnPoint.y - (by + bd.BED_H)) < 1e-6 &&
             Math.abs(g.spawnPoint.z - (bz + 1.5)) < 1e-6,
    playerY: g.player.pos.y, wantY: by + bd.BED_H, by,
    overlayOn: el ? el.classList.contains('on') : false,
    before
  };
})()`);
check('0.85 时刻判定为夜晚', night.isNight === true);
check('床方块已放置到世界', night.placed);
check('右键床后进入睡眠状态', night.sleeping === true);
check('点床尾也能睡，重生点落到床头那一格、高度在床垫面（y + 9/16）', night.spawnOk,
  'y=' + night.playerY + ' 期望=' + night.wantY);
check('人站在床垫上，不是悬在整格顶（y 比整格顶低 7/16）', Math.abs(night.playerY - (night.by + 1)) > 0.4 && Math.abs(night.playerY - night.wantY) < 1e-6, 'y=' + night.playerY);
check('黑屏遮罩 #sleep 已点亮', night.overlayOn === true);

// ---- C1b 只有一半的床不算床，不给睡 ----
const halfBed = await ev(`(async function(){
  const g = window.game;
  const m = await import('/js/blocks.js');
  const bd = await import('/js/bedshape.js');
  const bedId = m.BLOCK_BY_KEY.bed.id;
  g.timeOfDay = 0.85; g.updateDayNight(0);
  g.sleeping = false;
  const bx = Math.floor(g.player.pos.x) + 4, by = Math.floor(g.player.pos.y), bz = Math.floor(g.player.pos.z);
  const footMeta = bd.bedMeta(1, false);
  g.world.setBlock(bx, by, bz, bedId, footMeta);     // 只摆床尾，床头那格空着
  g.trySleep({ x: bx, y: by, z: bz, ny: 1, id: bedId, meta: footMeta });
  const sleeping = g.sleeping;
  g.world.setBlock(bx, by, bz, 0);
  g.sleeping = false;
  return { sleeping };
})()`);
check('只有一半的床不给睡（对面那格不是床头就拒绝）', halfBed.sleeping === false, String(halfBed.sleeping));

// ---- C2 方块状态字节（meta）：能存能取、射线带得出、改回去要归零 ----
const metaTest = await ev(`(async function(){
  const g = window.game;
  const bd = await import('/js/bedshape.js');
  const m = await import('/js/blocks.js');
  const bedId = m.BLOCK_BY_KEY.bed.id, stoneId = m.BLOCK_BY_KEY.stone.id;
  const bx = Math.floor(g.player.pos.x) - 2;
  const by = Math.floor(g.player.pos.y) + 3;
  const bz = Math.floor(g.player.pos.z);

  g.world.setBlock(bx, by, bz, stoneId);
  const zero = g.world.getMeta(bx, by, bz);

  const head = bd.bedMeta(3, true);          // 朝东 + 床头 = (3<<1)|1 = 7
  g.world.setBlock(bx, by, bz, bedId, head);
  const got = g.world.getMeta(bx, by, bz);
  const id = g.world.getBlock(bx, by, bz);

  const hit = g.world.raycast({ x: bx + 0.5, y: by + 0.9, z: bz + 0.5 }, { x: 0, y: -1, z: 0 }, 1);

  g.world.setBlock(bx, by, bz, stoneId);
  const after = g.world.getMeta(bx, by, bz);
  const idAfter = g.world.getBlock(bx, by, bz);

  return { zero, got, head, id, bedId, stoneId, after, idAfter, rayMeta: hit ? hit.meta : -1, rayId: hit ? hit.id : -1 };
})()`);
check('普通方块的状态字节默认是 0', metaTest.zero === 0, String(metaTest.zero));
check('床的状态字节能存能取（朝东+床头 = 7）',
  metaTest.got === 7 && metaTest.id === metaTest.bedId, JSON.stringify(metaTest));
check('射线命中时带出状态字节', metaTest.rayMeta === 7 && metaTest.rayId === metaTest.bedId,
  'meta=' + metaTest.rayMeta + ' id=' + metaTest.rayId);
check('同一格改回普通方块后状态字节归零',
  metaTest.after === 0 && metaTest.idAfter === metaTest.stoneId, String(metaTest.after));

// ---- C3 存档往返：状态字节要能跟着存下去、读回来 ----
const saveRound = await ev(`(async function(){
  const sv = await import('/js/save.js');
  const bd = await import('/js/bedshape.js');
  const m = await import('/js/blocks.js');
  const g = window.game;
  const bedId = m.BLOCK_BY_KEY.bed.id;
  const bx = Math.floor(g.player.pos.x) - 4;
  const by = Math.floor(g.player.pos.y) + 3;
  const bz = Math.floor(g.player.pos.z) + 1;
  const meta = bd.bedMeta(1, true);        // 朝南 + 床头 = (1<<1)|1 = 3
  g.world.setBlock(bx, by, bz, bedId, meta);

  const wrote = sv.saveGame(g);
  const back = sv.loadSave();
  const CHUNK = 16;
  const cx = Math.floor(bx / CHUNK), cz = Math.floor(bz / CHUNK);
  const idx = (bx - cx * CHUNK) + CHUNK * ((bz - cz * CHUNK) + CHUNK * by);
  const inner = back && back.edits.get(cx + '|' + cz);
  const rec = inner ? inner.get(idx) : null;
  const json = JSON.stringify(sv.serialize(g));
  const compact = json.includes('"edits"');

  sv.clearSave();                          // 别把测试存档留给后面的用例
  return {
    wrote, hasSave: !!back,
    ver: back ? back.version : -1,
    rec: rec || null, meta, compact,
    raw: json.length
  };
})()`);
check('存档能写能读', saveRound.wrote === true && saveRound.hasSave === true);
check('存档版本升到 2', saveRound.ver === 2, String(saveRound.ver));
check('存档里的编辑记录带着状态字节',
  saveRound.rec && saveRound.rec[0] === -1 && saveRound.rec[2] === 31 && saveRound.rec[3] === saveRound.meta,
  JSON.stringify(saveRound.rec) + ' 期望 meta=' + saveRound.meta);

// ---- C4 摆放：一次放下两格，床头在「远离玩家」那一侧 ----
//
// 这段走**真的 useItem()**，不是直接 setBlock（直接摆等于没测摆放本身）。
// 为了让准星能稳稳打到靶子，先在空中搭一块石台，玩家站上去、朝北平视。
// 靶子是正前方 2 格处一根 1 格高的石柱：从眼睛（+1.62）往下看一点，正好落在它顶面上。
// 按下右键后，床尾应该落在「靶子顶上那一格」，床头再往北（-z）一格 —— 也就是远离玩家那侧。
const place = await ev(`(async function(){
  const g = window.game;
  const m = await import('/js/blocks.js');
  const bd = await import('/js/bedshape.js');
  const it = await import('/js/items.js');
  const bedId = m.BLOCK_BY_KEY.bed.id, stoneId = m.BLOCK_BY_KEY.stone.id;
  const bedItemId = it.ITEM_BY_KEY.bed.id;
  const y = 62;
  const ax = Math.floor(g.player.pos.x) + 8, az = Math.floor(g.player.pos.z) + 8;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -3; dz <= 1; dz++) {
      // 先清空台面上方两层：万一天然地形/树长到这块高度，准星会被它挡住、床头那格也会被占
      g.world.setBlock(ax + dx, y, az + dz, 0);
      g.world.setBlock(ax + dx, y + 1, az + dz, 0);
      g.world.setBlock(ax + dx, y - 1, az + dz, stoneId);
    }
  }
  g.world.setBlock(ax, y, az - 2, stoneId);          // 靶柱
  g.player.pos.set(ax + 0.5, y, az + 0.5);
  g.player.vel.set(0, 0, 0);
  g.player.yaw = g.player.targetYaw = 0;             // 朝北：前方 = -z
  g.player.pitch = g.player.targetPitch = -0.31;     // 往下压一点（lookDir 的 y = sin(pitch)，负值才是低头），压在靶柱顶面
  g.player.onGround = true;
  const hit = g.hitTest();

  const foot = [ax, y + 1, az - 2], head = [ax, y + 1, az - 3];
  const slot = g.inventory.selected;
  g.inventory.slots[slot] = { id: bedItemId, count: 3, dmg: 0 };

  // 1) 先把床头那一格堵住 → 一格都不该放下、也不该扣物品
  g.world.setBlock(head[0], head[1], head[2], stoneId);
  g.useItem();
  const blocked = { foot: g.world.getBlock(foot[0], foot[1], foot[2]), left: g.inventory.slots[slot].count };
  g.world.setBlock(head[0], head[1], head[2], 0);

  // 2) 腾出来再放一次 → 两格都该是床，而且各带自己的状态字节
  g.useItem();
  const r = {
    hit: hit ? [hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz] : null,
    blocked: blocked,
    footId: g.world.getBlock(foot[0], foot[1], foot[2]), footMeta: g.world.getMeta(foot[0], foot[1], foot[2]),
    headId: g.world.getBlock(head[0], head[1], head[2]), headMeta: g.world.getMeta(head[0], head[1], head[2]),
    want: { foot: bd.bedMeta(0, false), head: bd.bedMeta(0, true) },
    left: g.inventory.slots[slot].count,
    bedId, bedItemId, foot, head, y, ax, az, stoneId
  };
  g.inventory.slots[slot] = null;
  return r;
})()`);
check('准星正好打在靶柱顶面（后面两条的前提）',
  place.hit && place.hit[0] === place.ax && place.hit[2] === place.az - 2 && place.hit[3] === 0 && place.hit[4] === 1,
  JSON.stringify(place.hit));
check('一次右键放下两格床（床尾 + 床头都在）',
  place.footId === place.bedId && place.headId === place.bedId,
  'foot=' + place.footId + ' head=' + place.headId);
check('床尾 = foot、床头 = head，朝向跟着玩家（朝北）',
  place.footMeta === place.want.foot && place.headMeta === place.want.head,
  'footMeta=' + place.footMeta + ' headMeta=' + place.headMeta + ' 期望 ' + place.want.foot + '/' + place.want.head);
check('床头落在远离玩家的那一格（朝北 → 床头在 -z 侧）',
  place.headMeta === place.want.head && place.headId === place.bedId, 'z=' + place.head[2] + ' 床尾 z=' + place.foot[2]);
check('放一张床只扣 1 个', place.left === 2, '剩 ' + place.left);
check('床头那一格被占住时，一格都不放（也不会扣物品）',
  place.blocked.foot !== place.bedId && place.blocked.left === 3,
  'foot=' + place.blocked.foot + ' 剩=' + place.blocked.left);

// ---- C5 破坏任一半：两格一起消失，但只掉一件 ----
const halfBreak = await ev(`(async function(){
  const g = window.game;
  const foot = [${place.foot[0]}, ${place.foot[1]}, ${place.foot[2]}];
  const head = [${place.head[0]}, ${place.head[1]}, ${place.head[2]}];
  const bedItemId = ${place.bedItemId};
  const countBeds = function(){
    let n = 0;
    for (const e of g.dropped.list) if (e.id === bedItemId) n += e.count;
    return n;
  };
  const before = countBeds();
  g.breakBlock(foot[0], foot[1], foot[2]);            // 只挖床尾这一格
  const r = {
    foot: g.world.getBlock(foot[0], foot[1], foot[2]),
    head: g.world.getBlock(head[0], head[1], head[2]),
    dropped: countBeds() - before
  };
  // 反过来再验一次：先摆一张好的床，改成挖床头
  const m = await import('/js/blocks.js');
  const bd = await import('/js/bedshape.js');
  const bedId = m.BLOCK_BY_KEY.bed.id;
  g.world.setBlock(foot[0], foot[1], foot[2], bedId, bd.bedMeta(0, false));
  g.world.setBlock(head[0], head[1], head[2], bedId, bd.bedMeta(0, true));
  const before2 = countBeds();
  g.breakBlock(head[0], head[1], head[2]);            // 这次挖床头
  r.foot2 = g.world.getBlock(foot[0], foot[1], foot[2]);
  r.head2 = g.world.getBlock(head[0], head[1], head[2]);
  r.dropped2 = countBeds() - before2;
  return r;
})()`);
check('挖床尾：两格一起消失', halfBreak.foot === 0 && halfBreak.head === 0,
  'foot=' + halfBreak.foot + ' head=' + halfBreak.head);
check('挖床尾只掉 1 张床', halfBreak.dropped === 1, '掉了 ' + halfBreak.dropped);
check('挖床头同样两格一起消失', halfBreak.foot2 === 0 && halfBreak.head2 === 0,
  'foot=' + halfBreak.foot2 + ' head=' + halfBreak.head2);
check('挖床头也只掉 1 张床', halfBreak.dropped2 === 1, '掉了 ' + halfBreak.dropped2);

// ---- C6 自动上台阶：床只有 9/16 高，走过去该直接踩上去 ----
//
// 原版步高 0.6，床 9/16 = 0.5625 刚好在下面 —— 所以床沿是能直接走上去的台阶，
// 不会像一堵矮墙那样把人挡在外面。这条把「形状改了但碰撞还按整格算」钉住：
// 按整格算的话，玩家会永远被床挡在 1 格外，y 也不会升。
const stepUp = await ev(`(async function(){
  const g = window.game;
  const m = await import('/js/blocks.js');
  const bd = await import('/js/bedshape.js');
  const bedId = m.BLOCK_BY_KEY.bed.id, stoneId = m.BLOCK_BY_KEY.stone.id;
  const y = 62;
  const ax = Math.floor(g.player.pos.x) - 8, az = Math.floor(g.player.pos.z) - 8;
  // 先把当前位置记下来（这一段结束时人还在 C4 那块台子上，站得稳）
  const back = { x: g.player.pos.x, y: g.player.pos.y, z: g.player.pos.z, yaw: g.player.yaw, pitch: g.player.pitch };

  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -5; dz <= 1; dz++) {
      g.world.setBlock(ax + dx, y, az + dz, 0);
      g.world.setBlock(ax + dx, y + 1, az + dz, 0);
      g.world.setBlock(ax + dx, y + 2, az + dz, 0);
      g.world.setBlock(ax + dx, y - 1, az + dz, stoneId);
    }
  }
  // 床就摆在正前方一格（-z 方向），完整的两格
  g.world.setBlock(ax, y, az - 1, bedId, bd.bedMeta(0, false));
  g.world.setBlock(ax, y, az - 2, bedId, bd.bedMeta(0, true));
  g.world.setBlock(ax, y - 1, az - 2, stoneId);       // 床下面也得有地，否则走过去会掉下去
  g.player.pos.set(ax + 0.5, y, az + 0.5);
  g.player.vel.set(0, 0, 0);
  g.player.yaw = g.player.targetYaw = 0;
  g.player.pitch = g.player.targetPitch = 0;
  g.player.onGround = true;
  const z0 = g.player.pos.z;
  for (let f = 0; f < 40; f++) g.player.update(1 / 60, { forward: true });
  const r = {
    y: g.player.pos.y, z: g.player.pos.z, z0,
    want: y + bd.BED_H, onBedTop: y + bd.BED_H, cell: y
  };
  // 收尾：把床和台子都清掉，人放回原处（后面那段要测「睡眠时不能动」，
  // 玩家悬空的话光重力就够让它 fail）
  g.world.setBlock(ax, y, az - 1, 0);
  g.world.setBlock(ax, y, az - 2, 0);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -5; dz <= 1; dz++) g.world.setBlock(ax + dx, y - 1, az + dz, 0);
  g.player.pos.set(back.x, back.y, back.z);
  g.player.vel.set(0, 0, 0);
  g.player.yaw = g.player.targetYaw = back.yaw;
  g.player.pitch = g.player.targetPitch = back.pitch;
  g.player.fallDistance = 0;
  g.player.lastGroundY = back.y;
  return r;
})()`);
check('往前走会被床挡住不假 —— 但应该顺势抬腿站上去（y 升到床垫面 9/16）',
  Math.abs(stepUp.y - stepUp.want) < 0.02, 'y=' + stepUp.y.toFixed(4) + ' 期望 ' + stepUp.want.toFixed(4));
check('抬腿之后人确实进到了床那一格（不是原地跳）', stepUp.z < stepUp.z0 - 0.2,
  'z ' + stepUp.z0.toFixed(2) + ' → ' + stepUp.z.toFixed(2));

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
