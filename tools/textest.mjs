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
// ---- C 生物模型：立方体展开图取面 + 3D 盒子几何 ----
//
// 生物不是一张贴纸，是一堆长方体拼出来的。每个盒子 (u0,v0,w,h,d) 的六个面
// 在皮肤图上按固定位置摊开：
//   top    [u0+d,     v0,   w, d]      bottom [u0+d+w,   v0,   w, d]
//   right  [u0,       v0+d, d, h]      front  [u0+d,     v0+d, w, h]
//   left   [u0+d+w,   v0+d, d, h]      back   [u0+d+w+d, v0+d, w, h]
// 断言分两层：
//   贴图侧：每个盒子按上面这条规则算出来的六个面，必须都落在真正画了东西的面板上
//           （「头取到侧脸」「身子取到顶面」这一类错误，靠这条抓住）；
//   几何侧：buildCube 造出来的必须是一个闭合长方体 —— 24 顶点 / 36 索引 /
//           没有退化三角形 / 每个三角形都垂直于某条轴 / 表面积等于 2(wh+hd+dw)。
// 几何侧是给「拿索引个数当顶点基址」那个 bug 兜底的：从第二个面开始整体错位，
// 盒子看上去像漏了一面，但顶点坐标本身还是对的，光量顶点和包围盒都抓不住。
const model = await ev(`(async function(){
  const { MODEL, buildCube } = await import('/js/mobtex.js');
  const FACE = [
    ['top',    (w, h, d) => [d, 0, w, d]],
    ['bottom', (w, h, d) => [d + w, 0, w, d]],
    ['right',  (w, h, d) => [0, d, d, h]],
    ['front',  (w, h, d) => [d, d, w, h]],
    ['left',   (w, h, d) => [d + w, d, d, h]],
    ['back',   (w, h, d) => [d + w + d, d, w, h]]
  ];
  const imgs = {};
  for (const t of Object.keys(MODEL)) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'textures/entity/' + t + '.png'; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    imgs[t] = { w: c.width, h: c.height, d: cx.getImageData(0, 0, c.width, c.height).data };
  }
  const px = (t, x, y) => {
    const im = imgs[t];
    if (x < 0 || y < 0 || x >= im.w || y >= im.h) return [0, 0, 0, 0];
    const i = (y * im.w + x) * 4;
    return [im.d[i], im.d[i + 1], im.d[i + 2], im.d[i + 3]];
  };
  const fill = (t, r) => {
    let n = 0, tot = 0;
    for (let j = 0; j < r[3]; j++) for (let i = 0; i < r[2]; i++) { tot++; if (px(t, r[0] + i, r[1] + j)[3] > 16) n++; }
    return tot ? n / tot : 0;
  };

  const parts = [];
  const geoms = [];
  for (const t of Object.keys(MODEL)) {
    for (const part of MODEL[t].parts) {
      const tex = part.tex || [0, 0, 1, 1, 1];
      const [u, v, tw, th, td] = tex;
      const solid = !!part.solid;
      let facesOk = 0, frontFill = 1, outOfBounds = 0;
      const rects = [];
      for (const [name, rectOf] of FACE) {
        const r = rectOf(tw, th, td);
        const rect = [u + r[0], v + r[1], r[2], r[3]];
        const f = solid ? 1 : fill(t, rect);
        rects.push({ name, rect, f: +f.toFixed(3) });
        if (f >= 0.95) facesOk++;
        if (name === 'front') frontFill = f;
        if (rect[0] < 0 || rect[1] < 0 || rect[0] + rect[2] > imgs[t].w || rect[1] + rect[3] > imgs[t].h) outOfBounds++;
      }
      parts.push({ t, name: part.name, solid, tex: part.tex || null, facesOk, frontFill, outOfBounds, rects });

      const [bx, by, bz, w, h, d] = part.box;
      const imgW = solid ? 1 : imgs[t].w;
      const imgH = solid ? 1 : imgs[t].h;
      const g = buildCube(part.box, solid ? [0, 0, 1, 1, 1] : part.tex, imgW, imgH, !!part.mirror);
      const pos = g.getAttribute('position').array;
      const uvs = g.getAttribute('uv').array;
      const idx = g.getIndex().array;
      const verts = [];
      for (let i = 0; i < pos.length; i += 3) verts.push([pos[i], pos[i + 1], pos[i + 2]]);
      const corners = [];
      for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) corners.push([bx + i * w, by + j * h, bz + k * d]);
      const near = (a, b) => Math.abs(a - b) < 1e-4;
      let offCorner = 0;
      for (const p of verts) {
        if (!corners.some((c) => near(c[0], p[0]) && near(c[1], p[1]) && near(c[2], p[2]))) offCorner++;
      }
      let degen = 0, notAxis = 0, area = 0;
      for (let i = 0; i < idx.length; i += 3) {
        const a = verts[idx[i]], b = verts[idx[i + 1]], c = verts[idx[i + 2]];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const ar = Math.hypot(cr[0], cr[1], cr[2]) / 2;
        if (ar < 1e-6) degen++;
        area += ar;
        // 长方体一个面的三个顶点，必定在某个轴的同一个坐标上
        const axis = (near(a[0], b[0]) && near(a[0], c[0]))
          || (near(a[1], b[1]) && near(a[1], c[1]))
          || (near(a[2], b[2]) && near(a[2], c[2]));
        if (!axis) notAxis++;
      }
      let uvOut = 0;
      for (let i = 0; i < uvs.length; i++) if (uvs[i] < -1e-6 || uvs[i] > 1 + 1e-6) uvOut++;
      geoms.push({
        t, name: part.name, solid,
        vtx: pos.length / 3, tri: idx.length / 3,
        maxIdx: idx.length ? Math.max.apply(null, Array.from(idx)) : -1,
        offCorner, degen, notAxis, uvOut,
        area: +area.toFixed(4), areaWant: +(2 * (w * h + h * d + d * w)).toFixed(4)
      });
    }
  }
  return { parts, geoms };
})()`);

// 有两块贴图原版就有意留白，不算缺陷：
//   skeleton|body  胸腔本来就是画成「骨头之间透空」的
//   猪鼻子 / 牛乳房 是 1 像素厚的薄片，背面那张面板原版没画
const HOLEY = ['skeleton|body', 'pig|snout', 'cow|udder'];
const partKey = (p) => p.t + '|' + p.name;
const badFaces = model.parts.filter((p) => !p.solid && !HOLEY.includes(partKey(p)) && p.facesOk < 5);
check('除原版留白外，每个盒子的六个面都落在真实面板上（不合格 ' + badFaces.length + ' 个）',
  badFaces.length === 0,
  badFaces.map((p) => partKey(p) + ' ' + p.facesOk + '/6 ' + JSON.stringify(p.rects.map((r) => r.name + '=' + r.f))).join(' | '));

const hollow = model.parts.filter((p) => !p.solid && !HOLEY.includes(partKey(p)) && p.frontFill < 0.95);
check('每个盒子的正面都有画东西（不合格 ' + hollow.length + ' 个）',
  hollow.length === 0,
  hollow.map((p) => partKey(p) + ' ' + p.frontFill.toFixed(2)).join(' | '));

const oob = model.parts.filter((p) => p.outOfBounds);
check('每个盒子取贴图都没越界（越界 ' + oob.length + ' 个）', oob.length === 0,
  oob.map(partKey).join(' | '));

const vtxBad = model.geoms.filter((g) => g.vtx !== 24 || g.tri !== 12 || g.maxIdx !== 23);
const idxBad = model.geoms.filter((g) => g.maxIdx >= g.vtx);
check('每个盒子都是 24 个顶点、12 个三角形、索引不越界（不合格 ' + (vtxBad.length + idxBad.length) + ' 个）',
  vtxBad.length === 0 && idxBad.length === 0,
  vtxBad.concat(idxBad).map((g) => g.t + '|' + g.name + ' ' + g.vtx + 'v ' + g.tri + 't max' + g.maxIdx).join(' | '));

const offc = model.geoms.filter((g) => g.offCorner > 0);
check('每个顶点都落在盒子的八个角上（跑偏 ' + offc.length + ' 个盒）', offc.length === 0,
  offc.map((g) => g.t + '|' + g.name + ' ' + g.offCorner + 'v').join(' | '));

const degen = model.geoms.filter((g) => g.degen > 0);
check('没有退化三角形（面积为 0）', degen.length === 0,
  degen.map((g) => g.t + '|' + g.name + ' ' + g.degen + '个').join(' | '));

// 这条是「索引串了面」的回归网：错位之后会出现跨两个面的三角形，
// 它的三个顶点不在任何一个轴的同一个坐标上。
const notAxis = model.geoms.filter((g) => g.notAxis > 0);
check('每个三角形都垂直于某条轴（面没有串到一起）（串了 ' + notAxis.length + ' 个盒）',
  notAxis.length === 0,
  notAxis.map((g) => g.t + '|' + g.name + ' ' + g.notAxis + '/' + g.tri).join(' | '));

const areaBad = model.geoms.filter((g) => Math.abs(g.area - g.areaWant) > 0.01);
check('每个盒子的表面积等于 2(wh+hd+dw)（不合格 ' + areaBad.length + ' 个）', areaBad.length === 0,
  areaBad.map((g) => g.t + '|' + g.name + ' ' + g.area + ' vs ' + g.areaWant).join(' | '));

// 鸡腿是没有贴图的纯色块，它的 uv 是拿一张 1x1 假图算的，不参与这条检查
const uvBad = model.geoms.filter((g) => !g.solid && g.uvOut > 0);
check('所有 uv 都落在 0..1 里（跑出去 ' + uvBad.length + ' 个盒）', uvBad.length === 0,
  uvBad.map((g) => g.t + '|' + g.name + ' ' + g.uvOut + '个').join(' | '));

check('七只生物一共 ' + model.parts.length + ' 个盒子全部通过几何检查',
  model.parts.length === 48,
  '盒子数 ' + model.parts.length);

// 模型高度必须正好等于判定框高度、而且脚踩在 y=0 上 —— 否则贴图再对，
// 生物也是悬空或者穿地的。顺带量一下每块在 y 上的范围，能一眼看出谁没接上。
const built = await ev(`(async function(){
  const THREE = await import('/js/vendor/three.module.js');
  const { buildMobMesh, MODEL, buildMobArt, mobArt } = await import('/js/mobtex.js');
  const { MOB_TYPES } = await import('/js/mobs.js');
  if (!mobArt.pig) await buildMobArt();
  const out = [];
  for (const t of Object.keys(MODEL)) {
    const def = MOB_TYPES[t];
    const mesh = buildMobMesh(t, def);
    if (!mesh) { out.push({ t, error: 'buildMobMesh 返回 null' }); continue; }
    const bb = new THREE.Box3().setFromObject(mesh);
    const rows = [];
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      const b = new THREE.Box3().setFromObject(o);
      rows.push({ name: o.name, lo: +b.min.y.toFixed(3), hi: +b.max.y.toFixed(3) });
    });
    out.push({
      t, def: { w: def.w, h: def.h },
      y: +(bb.max.y - bb.min.y).toFixed(3),
      minY: +bb.min.y.toFixed(4),
      x: +(bb.max.x - bb.min.x).toFixed(3),
      z: +(bb.max.z - bb.min.z).toFixed(3),
      rows,
      meshes: rows.length,
      mats: mesh.userData.mats.length,
      legsA: mesh.userData.legs.length, legsB: mesh.userData.legsB.length,
      armsA: mesh.userData.arms.length, armsB: mesh.userData.armsB.length
    });
  }
  return out;
})()`);

const tallBad = built.filter((m) => !m.error && Math.abs(m.y - m.def.h) > 0.005);
check('七只渲染高度都等于判定框高度（差太多的 ' + tallBad.length + ' 只）', tallBad.length === 0,
  tallBad.map((m) => m.t + ' ' + m.y + ' vs ' + m.def.h).join(' | '));

const floatBad = built.filter((m) => !m.error && Math.abs(m.minY) > 0.005);
check('七只的脚都踩在 y=0 上（悬空/穿地 ' + floatBad.length + ' 只）', floatBad.length === 0,
  floatBad.map((m) => m.t + ' ' + m.minY).join(' | '));

const errBad = built.filter((m) => m.error);
check('七只都能造出网格', built.length === 7 && errBad.length === 0, JSON.stringify(built.map((m) => m.t)));

const meshBad = built.filter((m) => !m.error && m.meshes !== model.parts.filter((p) => p.t === m.t).length);
check('每只的网格块数等于 MODEL 表里的盒子数（对不上 ' + meshBad.length + ' 只）', meshBad.length === 0,
  meshBad.map((m) => m.t + ' ' + m.meshes).join(' | '));

// 每块的底边不能悬在半空：所有「腿」都必须落到 y=0 附近，
// 而头/身子必须在腿上面。这条是「身子写成了竖条/腿装反了」的兜底。
const legBad = [];
for (const m of built) {
  if (m.error) continue;
  const legs = m.rows.filter((r) => r.name === 'leg');
  for (const l of legs) if (Math.abs(l.lo) > 0.005) legBad.push(m.t + '|leg lo=' + l.lo);
  const head = m.rows.find((r) => r.name === 'head');
  if (head && head.lo <= 0.005) legBad.push(m.t + '|head 贴地了 lo=' + head.lo);
}
check('每条腿都落到地面、头不贴地（异常 ' + legBad.length + ' 条）', legBad.length === 0, legBad.join(' | '));

// 鸡腿是没有贴图的纯色块（chicken.png 那块腿是透空的），材质得是两份
const chicken = built.find((m) => m.t === 'chicken');
check('鸡腿走纯色材质（鸡有两种材质）', !!chicken && chicken.mats === 2, chicken ? String(chicken.mats) : '?');
const others = built.filter((m) => !m.error && m.t !== 'chicken' && m.mats !== 1);
check('其余六只都只用一份贴图材质', others.length === 0, others.map((m) => m.t + ' ' + m.mats).join(' | '));

const quad = built.filter((m) => ['pig', 'cow', 'sheep', 'creeper'].includes(m.t));
const quadBad = quad.filter((m) => m.legsA !== 2 || m.legsB !== 2);
check('四足生物是四条腿、按对角线分成两组反相（不合格 ' + quadBad.length + ' 只）', quadBad.length === 0,
  quadBad.map((m) => m.t + ' ' + m.legsA + '/' + m.legsB).join(' | '));

const biped = built.filter((m) => ['zombie', 'skeleton'].includes(m.t));
const bipedBad = biped.filter((m) => m.legsA !== 1 || m.legsB !== 1 || m.armsA !== 1 || m.armsB !== 1);
check('人形是一对腿加一对胳膊（不合格 ' + bipedBad.length + ' 只）', bipedBad.length === 0,
  bipedBad.map((m) => m.t).join(' | '));

const walkable = built.filter((m) => ['pig', 'cow', 'sheep'].includes(m.t));
const deepBad = walkable.filter((m) => m.z / m.y < 0.8);
check('四足动物身子是横躺的（长比高 ' + walkable.map((m) => m.t + '=' + (m.z / m.y).toFixed(2)).join(' ') + '）',
  deepBad.length === 0, deepBad.map((m) => m.t + ' ' + (m.z / m.y).toFixed(2)).join(' | '));

// ---- C3 方块六个面各用哪张贴图 ----
//
// tiles 只有 [顶, 侧面, 底] 三项，四个侧面天然共用一张 —— 于是凡是「正面和侧面不一样」
// 的方块，四个侧面全长一个样。熔炉原版就一个炉门，这里曾经四面都是炉门。
// 方块可以用 faces 表按方向覆盖单面，这条断言直接去建出来的几何里量：
// 把一个孤零零的熔炉丢进空区块，六个面各取哪张图，一个个认出来。
const faceTiles = await ev(`(async function(){
  const { BLOCKS } = await import('/js/blocks.js');
  const { buildSectionBatches } = await import('/js/mesher.js');
  const { TILE_NAMES, ATLAS_COLS } = await import('/js/textures.js');
  const FID = BLOCKS.find(function(b){ return b.key === 'furnace'; }).id;
  const HEIGHT = 80, CHUNK = 16;
  const vol = CHUNK * CHUNK * HEIGHT;
  const ch = {
    cx: 0, cz: 0,
    data: new Uint8Array(vol),
    skyLight: new Uint8Array(vol).fill(15),
    blockLight: new Uint8Array(vol)
  };
  const bx = 4, by = 40, bz = 4;
  ch.data[bx + CHUNK * (bz + CHUNK * by)] = FID;
  const buf = buildSectionBatches(ch, 2, { getChunk: function(){ return ch; }, useAO: false }).opaque;

  // 顶点按「四个一组」切成面，每个面里那个恒定的坐标轴就是它的法线方向。
  // 不能按「顶点碰到了 bx/bx+1」来判断方向 —— 每个面的顶点都同时落在两面墙上。
  const out = {};
  const NAMES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  const org = [bx, by, bz];
  for (let q = 0; q * 12 + 11 < buf.pos.length; q++) {
    const base = q * 12;
    const p = [];
    for (let k = 0; k < 4; k++) p.push([buf.pos[base + k * 3], buf.pos[base + k * 3 + 1], buf.pos[base + k * 3 + 2]]);
    let axis = -1, val = 0;
    for (let a = 0; a < 3; a++) {
      if (p[0][a] === p[1][a] && p[1][a] === p[2][a] && p[2][a] === p[3][a]) { axis = a; val = p[0][a]; }
    }
    const key = axis < 0 ? 'other' : NAMES[axis * 2 + (val === org[axis] ? 1 : 0)];
    const f = out[key] || (out[key] = { n: 0, u: 9, v: 9 });
    f.n++;
    for (let k = 0; k < 4; k++) {
      const j = (base / 3 + k) * 2;
      if (buf.uv[j] < f.u) f.u = buf.uv[j];
      if (buf.uv[j + 1] < f.v) f.v = buf.uv[j + 1];
    }
  }
  const s = 1 / ATLAS_COLS;
  for (const k in out) {
    const f = out[k];
    const col = Math.round(f.u / s);
    const row = Math.round((1 - f.v) / s) - 1;
    f.tile = TILE_NAMES[row * ATLAS_COLS + col];
  }
  return out;
})()`);

const sides = ['px', 'nx', 'pz', 'nz'].map((k) => faceTiles[k] && faceTiles[k].tile);
const doorCount = sides.filter((t) => t === 'furnace_front').length;
check('一个孤零零的熔炉建出 6 个面（六个方向各一个）',
  ['px', 'nx', 'py', 'ny', 'pz', 'nz'].every((k) => faceTiles[k] && faceTiles[k].n === 1),
  JSON.stringify(faceTiles));
check('熔炉只有一面是炉门（实测 ' + doorCount + ' 面是 furnace_front）', doorCount === 1, JSON.stringify(sides));
check('熔炉顶面是 furnace_top、底面是 furnace_side',
  faceTiles.py && faceTiles.py.tile === 'furnace_top' && faceTiles.ny && faceTiles.ny.tile === 'furnace_side',
  (faceTiles.py && faceTiles.py.tile) + ' / ' + (faceTiles.ny && faceTiles.ny.tile));
check('熔炉另外三个侧面是 furnace_side（' + sides.filter((t) => t === 'furnace_side').length + ' 面）',
  sides.filter((t) => t === 'furnace_side').length === 3, JSON.stringify(sides));

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
