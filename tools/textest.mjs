// 贴图与颜色回归：颜色空间、护甲染色、生物立绘裁剪。
//
// 这三样都是「肉眼能看出不对、但代码跑起来不报错」的坑：
//   1) 画布贴图没声明 sRGB → 整个世界的方块整体偏亮、颜色发白；
//   2) 皮质护甲是灰度蒙版没染色 → 和铁甲一样灰；
//   3) 生物立绘的裁剪框骑到贴图的透明缝上 → alphaTest 一抠，身上出破洞。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-textest-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--window-size=900,560',
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
const attached = await cdp.send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
cdp.session = attached.result.sessionId;

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: APP });
await sleep(2500);

async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
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
  ready = await ev('!!(window.game && window.game.world && window.game.atlasCanvas)');
  if (ready) break;
  await sleep(500);
}
check('游戏初始化完成（含 atlasCanvas）', ready);
await ev(`(function(){ const b=document.getElementById('start-btn'); if(b) b.click(); return true; })()`);
await sleep(1200);

// ---- A 颜色空间：画布/图片贴图必须声明成 sRGB ----
//
// three r160 里 ColorManagement.enabled 默认 true、渲染器输出 sRGB，
// 贴图要是不声明 sRGB，颜色就会「不解码直接当线性值算，输出时再编码一遍」，
// 结果整体亮一大截。实测 128,96,64 会变成 188,165,137。
const colors = await ev(`(async function(){
  const THREE = await import('/js/vendor/three.module.js');
  const { mobArt } = await import('/js/mobtex.js');
  const g = window.game;
  const seen = new Map();
  g.scene.traverse((o) => {
    const m = o.material; if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mm of list) if (mm.map && mm.map.isTexture) seen.set(mm.map.uuid, mm.map);
  });
  const rows = [];
  for (const t of seen.values()) rows.push(t.colorSpace || '');
  const mob = [];
  for (const k in mobArt) mob.push(mobArt[k].tex.colorSpace || '');
  return {
    enabled: THREE.ColorManagement.enabled,
    output: g.renderer.outputColorSpace,
    atlas: g.world.atlasTexture.colorSpace || '',
    drop: (function(){ const d = g.dropped; if (!d || !d.texCache) return '(没有掉落物)'; for (const t of d.texCache.values()) return t.colorSpace || ''; return '(缓存为空)'; })(),
    sceneCount: rows.length,
    sceneSrgb: rows.filter((c) => c === 'srgb').length,
    mobSrgb: mob.filter((c) => c === 'srgb').length,
    mobCount: mob.length
  };
})()`);
check('引擎开着颜色管理', colors.enabled === true, String(colors.enabled));
check('渲染器输出是 sRGB', colors.output === 'srgb', colors.output);
check('世界方块图集声明了 sRGB', colors.atlas === 'srgb', colors.atlas);
check('场景里所有贴图都是 sRGB（' + colors.sceneSrgb + '/' + colors.sceneCount + '）',
  colors.sceneCount > 0 && colors.sceneSrgb === colors.sceneCount, JSON.stringify(colors));
check('七张生物贴图都是 sRGB', colors.mobCount === 7 && colors.mobSrgb === 7, colors.mobSrgb + '/' + colors.mobCount);

// 落一个物品在地上，看它的贴图有没有声明
const dropColor = await ev(`(async function(){
  const g = window.game;
  const { itemId } = await import('/js/items.js');
  const p = g.player.pos;
  const d = g.dropped.spawn(itemId('iron_pickaxe'), 1, p.x, p.y + 1.2, p.z, { x: 0, y: 0, z: 0 });
  const t = g.dropped.textureFor(itemId('iron_pickaxe'));
  const r = t.colorSpace || '';
  g.dropped.clear ? g.dropped.clear() : 0;
  return r;
})()`);
check('掉在地上的物品贴图是 sRGB', dropColor === 'srgb', dropColor);

// 天空：太阳/月亮/云
const skyColor = await ev(`(function(){
  const g = window.game;
  const s = g.sky;
  if (!s || !s.clouds) return '(没有天空)';
  return [s.sun.material.map.colorSpace || '', s.moon.material.map.colorSpace || '', s.clouds.material.map.colorSpace || ''].join(',');
})()`);
check('太阳/月亮/云的贴图都是 sRGB', skyColor === 'srgb,srgb,srgb', skyColor);

// 用真实渲染验证：同一张画布，标了 sRGB 和不标，屏幕上差多少
const shift = await ev(`(async function(){
  const THREE = await import('/js/vendor/three.module.js');
  const src = document.createElement('canvas');
  src.width = 4; src.height = 4;
  const sc = src.getContext('2d');
  sc.fillStyle = 'rgb(128,96,64)';
  sc.fillRect(0, 0, 4, 4);
  const mk = (cs) => {
    const t = new THREE.CanvasTexture(src);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    if (cs) t.colorSpace = cs;
    return t;
  };
  const r2 = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false });
  r2.setSize(128, 64);
  r2.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 10);
  cam.position.z = 1;
  const add = (tex, x) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.5), new THREE.MeshBasicMaterial({ map: tex })); m.position.set(x, 0, 0); scene.add(m); };
  add(mk(null), -0.5);
  add(mk(THREE.SRGBColorSpace), 0.5);
  r2.render(scene, cam);
  const gl = r2.getContext();
  const read = (x, y) => { const p = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return [p[0], p[1], p[2]]; };
  const plain = read(32, 32);
  const srgb = read(96, 32);
  r2.dispose();
  return { plain, srgb };
})()`);
check('不声明 sRGB 会把 128,96,64 画成 ' + shift.plain.join(',') + '（偏亮）',
  shift.plain[0] > 170 && shift.plain[1] > 150, JSON.stringify(shift));
check('声明 sRGB 后原样输出 ' + shift.srgb.join(','), shift.srgb.join(',') === '128,96,64', JSON.stringify(shift));

// ---- B 皮质护甲染色 ----
//
// 原版四张皮甲贴图是灰度蒙版，得乘上 #A06540 才变棕色。漏了这一步就会跟铁甲一样灰。
const armor = await ev(`(async function(){
  const { TILE_INDEX } = await import('/js/textures.js');
  const atlas = window.game.atlasCanvas;
  const ctx = atlas.getContext('2d');
  const names = ['leather_helmet','leather_chestplate','leather_leggings','leather_boots',
                 'iron_helmet','iron_chestplate','iron_leggings','iron_boots',
                 'golden_helmet','diamond_helmet'];
  const out = {};
  for (const n of names) {
    const i = TILE_INDEX[n];
    if (i === undefined) { out[n] = null; continue; }
    const col = i % 16, row = (i / 16) | 0;
    const d = ctx.getImageData(col * 16, row * 16, 16, 16).data;
    let r = 0, g = 0, b = 0, c = 0;
    for (let k = 0; k < d.length; k += 4) {
      if (d[k + 3] <= 16) continue;
      c++; r += d[k]; g += d[k + 1]; b += d[k + 2];
    }
    out[n] = c ? [Math.round(r / c), Math.round(g / c), Math.round(b / c)] : null;
  }
  return out;
})()`);
const leatherNames = ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots'];
let leatherOk = true, leatherDetail = [];
for (const n of leatherNames) {
  const c = armor[n];
  // 棕色 = 红 > 绿 > 蓝，且红蓝有明显差
  const ok = c && c[0] > c[1] && c[1] > c[2] && (c[0] - c[2]) > 25;
  if (!ok) leatherOk = false;
  leatherDetail.push(n + '=' + (c ? c.join(',') : 'null'));
}
check('四件皮甲染成了棕色（' + leatherDetail.join('  ') + '）', leatherOk, leatherDetail.join(' | '));
check('铁甲保持灰色', armor.iron_helmet && armor.iron_helmet[0] === armor.iron_helmet[1] && armor.iron_helmet[1] === armor.iron_helmet[2], JSON.stringify(armor.iron_helmet));
check('金甲没被皮甲染色波及', armor.golden_helmet && armor.golden_helmet[1] > armor.golden_helmet[2], JSON.stringify(armor.golden_helmet));
check('钻石甲没被皮甲染色波及', armor.diamond_helmet && armor.diamond_helmet[2] > armor.diamond_helmet[0], JSON.stringify(armor.diamond_helmet));

// ---- C 生物立绘的裁剪框不能骑到贴图的透明缝上 ----
const crops = await ev(`(async function(){
  const { PART, compose, partSize } = await import('/js/mobtex.js');
  const types = Object.keys(PART);
  const rects = [];
  const comps = [];
  const fronts = [];
  for (const t of types) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'textures/entity/' + t + '.png'; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const SW = c.width;
    const px = (x, y) => { const i = (y * SW + x) * 4; return [d[i], d[i+1], d[i+2], d[i+3]]; };
    const p = PART[t];

    // 头的裁剪框必须是「立方体展开图」里的正面。
    //
    // 这七张图是 MC 的皮肤图：某个盒子 (u0,v0,w,h,d) 的六个面按固定位置摊开，
    // 正面精确落在 (u0+d, v0+d, w, h)。所以反查一遍 —— 如果存在一个盒子，
    // 它的六个面都有像素、且展开包围盒里那两个不属于任何面的 d x d 角是透明的，
    // 那么这个框就是一块真实存在的正面的位置。
    //
    // 为什么光查「框里有像素」不够：侧脸那一块同样有像素。当初牛头写的是
    // [8,8,8,6]，右眼加半个侧脸全在里面，看上去一切正常，实际脸是歪的。
    // 这条规则恰好否掉它，放行 7 个正确的头。
    const opaqueBox = (x, y, w, h) => {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (px(x + i, y + j)[3] <= 16) return false;
      return true;
    };
    const clearBox = (x, y, w, h) => {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (px(x + i, y + j)[3] > 16) return false;
      return true;
    };
    const head = p.head;
    let front = 0;
    for (let d = 1; d <= 10 && !front; d++) {
      const u0 = head[0] - d, v0 = head[1] - d, w = head[2], h = head[3];
      if (u0 < 0 || v0 < 0) continue;
      const six = [
        [u0 + d, v0, w, d], [u0 + d + w, v0, w, d],
        [u0, v0 + d, d, h], [head[0], head[1], w, h],
        [u0 + d + w, v0 + d, d, h], [u0 + d + w + d, v0 + d, w, h]
      ];
      if (six.some((f) => f[0] < 0 || f[1] < 0 || f[0] + f[2] > c.width || f[1] + f[3] > c.height)) continue;
      if (!six.every((f) => opaqueBox(f[0], f[1], f[2], f[3]))) continue;
      if (!clearBox(u0, v0, d, d)) continue;
      if (!clearBox(u0 + d + 2 * w, v0, d, d)) continue;
      front = d;
    }
    fronts.push({ t, r: head, front });

    for (const name of ['head', 'body', 'leg']) {
      const r = p[name];
      // 扫的是「裁剪框在源图里覆盖的那块面积」。带 rot 的框只是把这同一批
      // 源像素转个方向再贴，覆盖的像素集合没变，所以这里按 r[2] x r[3] 扫是对的。
      let n = 0, tot = 0;
      for (let y = 0; y < r[3]; y++) for (let x = 0; x < r[2]; x++) { tot++; if (px(r[0] + x, r[1] + y)[3] > 16) n++; }
      rects.push({ t, name, r, pct: n / tot * 100 });
    }

    // 部件区（头 / 身子 / 两条腿的粘贴位置）里不能有透明像素，
    // 否则 alphaTest 会把它们抠掉，看起来就是身上有洞。
    const canvas = compose(t, img);
    const cc = canvas.getContext('2d');
    const cd = cc.getImageData(0, 0, canvas.width, canvas.height).data;
    const W = canvas.width, H = canvas.height;
    const legW = partSize(p.leg).w;
    const legTotal = legW * 2 + p.gap;
    const bodyY = p.peek === 0 ? partSize(p.head).h : p.peek;
    const legY = bodyY + partSize(p.body).h - 1 + (p.legGap || 0);
    const lx = ((W - legTotal) / 2) | 0;
    // 粘贴位置要按「转完之后的尺寸」算，跟 compose() 里的排布逐项对齐。
    const boxes = [
      [((W - partSize(p.body).w) / 2) | 0, bodyY, partSize(p.body).w, partSize(p.body).h],
      [((W - partSize(p.head).w) / 2) | 0, 0, partSize(p.head).w, partSize(p.head).h],
      [lx, legY, legW, partSize(p.leg).h],
      [lx + legW + p.gap, legY, legW, partSize(p.leg).h]
    ];
    let holes = 0, area = 0, trans = 0;
    for (const b of boxes) {
      for (let y = b[1]; y < b[1] + b[3]; y++) {
        for (let x = b[0]; x < b[0] + b[2]; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          area++;
          if (cd[(y * W + x) * 4 + 3] <= 16) holes++;
        }
      }
    }
    for (let i = 3; i < cd.length; i += 4) if (cd[i] <= 16) trans++;
    comps.push({ t, w: W, h: H, holes, area, trans });
  }
  return { rects, comps, fronts };
})()`);

// 骨架的胸腔是贴图本身画成「骨头之间留空」的，所以它的身子框允许有洞，
// 靠 compose() 逐行补色填平。其余 20 个框必须整个落在真实面板里。
const GROUNDED = ['skeleton|body'];
const badRects = crops.rects.filter((r) => r.pct < 100 && !GROUNDED.includes(r.t + '|' + r.name));
check('除骨架身子外，裁剪框全部 100% 落在真实面板里（不合格 ' + badRects.length + ' 个）',
  badRects.length === 0,
  badRects.map((r) => r.t + ' ' + r.name + ' ' + JSON.stringify(r.r) + ' ' + r.pct.toFixed(1) + '%').join(' | '));

const skel = crops.rects.find((r) => r.t === 'skeleton' && r.name === 'body');
check('骨架身子框确实是有洞的那种面板（' + (skel ? skel.pct.toFixed(1) : '?') + '%，靠补色填平）',
  !!skel && skel.pct < 100, skel ? skel.pct.toFixed(1) + '%' : '没有这个框');

// 头的裁剪框必须是立方体展开图里的正面。这是「生物的脸是歪的」那个 bug 的
// 回归网 —— 光靠上面那条「框里有像素」是抓不住的，侧脸那块同样有像素。
const badFaces = crops.fronts.filter((f) => !f.front);
check('七张脸都取自立方体展开图的正面（不合格 ' + badFaces.length + ' 个）',
  crops.fronts.length === 7 && badFaces.length === 0,
  badFaces.map((f) => f.t + ' ' + JSON.stringify(f.r)).join(' | '));

const badComps = crops.comps.filter((c) => c.holes !== 0);
check('七张立绘的部件区都没有透明像素（破洞）',
  crops.comps.length === 7 && badComps.length === 0,
  badComps.map((c) => c.t + ' 洞' + c.holes + '/' + c.area).join(' | '));

const creeperSkel = crops.comps.find((c) => c.t === 'skeleton');
check('骨架的胸口补上了（不再能透过身子看见背景）',
  !!creeperSkel && creeperSkel.holes === 0, creeperSkel ? String(creeperSkel.holes) : '?');

// 立绘整体还得是「有轮廓的立绘」：补洞只补部件区内部的洞，
// 部件区之外（比如两条腿之间）必须还是透明的，不能被填成一整块色块。
const shaped = crops.comps.filter((c) => c.trans > 0);
check('七张立绘都还有透明轮廓（补洞没有把整张图填成方块）',
  shaped.length === 7, JSON.stringify(crops.comps.map((c) => c.t + ': 透明' + c.trans + '/' + (c.w * c.h))));

// ---- D 单帧渲染不能报错 ----
const renderErr = await ev(`(function(){
  const g = window.game;
  g.renderer.render(g.scene, g.camera);
  return true;
})()`);
check('渲染一帧不报错', renderErr === true);
check('整轮没有 JS 报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

console.log('\n================ 贴图与颜色验证 ================');
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
