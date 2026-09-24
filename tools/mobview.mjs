// 把七只生物摆在干净的转台上拍一圈，用来肉眼确认「它真的是立体的、脸是对的」。
//
// 为什么不用游戏里的相机拍：游戏里生物会追人、会自燃、站位随机，
// 拍出来的东西没法比对。这里自己起一个小场景，位置和角度都是钉死的。
//
// 用法：
//   node serve.mjs &                      先起静态服务器（127.0.0.1:8321）
//   node tools/mobview.mjs                默认：每只 10 个机位、5 列 2 行、280x240
//   node tools/mobview.mjs --w=560 --h=480 --cols=2 --only=pig --views=head-front,head-left
//
// 参数：--w --h 单元格尺寸，--cols 每行几个，--only 只拍某几只（逗号分隔），
//       --views 只拍某几个机位，--out 输出目录（默认 screenshots）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};

const W = Number(arg('w', 280));
const H = Number(arg('h', 240));
const COLS = Number(arg('cols', 5));
const OUT = arg('out', path.join(process.cwd(), 'screenshots'));
const ONLY = arg('only', '');
const VIEWS = arg('views', '');
const ISOLATE = arg('isolate', '') === '1';
const PORT = Number(arg('port', 9321));

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = 'http://127.0.0.1:8321/';
const userDir = path.join(os.tmpdir(), 'mc-mobview-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--window-size=1000,700',
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
  throw new Error('devtools 未启动（先跑 node serve.mjs）');
}

const version = await waitForDevtools();

const ws = new WebSocket(version.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const errors = [];
let session = null;

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push('EXCEPTION: ' + (d.exception ? d.exception.description || d.exception.value : d.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
  }
});
await new Promise((r) => ws.addEventListener('open', r));

function send(method, params) {
  const id = ++msgId;
  const payload = { id, method, params: params || {} };
  if (session) payload.sessionId = session;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve) => pending.set(id, { resolve }));
}

const created = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
session = attached.result.sessionId;
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: APP });
await sleep(2500);

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    throw new Error('evaluate 失败: ' + JSON.stringify(r.result.exceptionDetails));
  }
  return r.result.result.value;
}

for (let i = 0; i < 60; i++) {
  if (await ev('!!(window.game && window.game.world)')) break;
  await sleep(400);
}

// 这一段会被注入到页面里跑，必须自包含（拿不到外面的变量，只吃传进去的 cfg）
async function shootAll(cfg) {
  const THREE = await import('/js/vendor/three.module.js');
  const mobtex = await import('/js/mobtex.js');
  const { MOB_TYPES } = await import('/js/mobs.js');
  if (!mobtex.mobArt.pig) await mobtex.buildMobArt();

  const { W, H, COLS, ORDER, VIEWS } = cfg;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fbcd4);
  const cam = new THREE.PerspectiveCamera(30, W / H, 0.02, 200);
  // 地面参考线：一眼看出脚有没有踩在地上
  const ground = new THREE.GridHelper(4, 16, 0x4a7a9c, 0x4a7a9c);
  ground.material.transparent = true;
  ground.material.opacity = 0.5;
  scene.add(ground);

  const out = {};
  const report = {};

  for (const type of ORDER) {
    const def = MOB_TYPES[type];
    const mesh = mobtex.buildMobMesh(type, def);
    if (!mesh) { report[type] = { error: 'buildMobMesh 返回 null' }; continue; }
    scene.add(mesh);

    const bb = new THREE.Box3().setFromObject(mesh);
    let tris = 0, meshes = 0;
    const partY = [];
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const idx = o.geometry.getIndex();
      tris += idx ? idx.count / 3 : o.geometry.getAttribute('position').count / 3;
      const b = new THREE.Box3().setFromObject(o);
      partY.push({ name: o.name, lo: +b.min.y.toFixed(3), hi: +b.max.y.toFixed(3) });
    });

    report[type] = {
      hitbox: [def.w, def.h],
      world: {
        x: +(bb.max.x - bb.min.x).toFixed(3),
        y: +(bb.max.y - bb.min.y).toFixed(3),
        z: +(bb.max.z - bb.min.z).toFixed(3),
        minY: +bb.min.y.toFixed(4)
      },
      meshes, tris,
      ud: {
        legs: mesh.userData.legs.length,
        legsB: mesh.userData.legsB.length,
        arms: mesh.userData.arms.length,
        mats: mesh.userData.mats.length
      },
      partY
    };

    const h = def.h;
    // 机位距离按包围球算，保证整只（含斜视角）都在画面里
    const rad3 = 0.5 * Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
    const D = (rad3 / Math.sin((30 * Math.PI) / 360)) * 1.18;
    const bodyC = new THREE.Vector3(0, h * 0.5, 0);

    // 头部特写：镜头对准头，距离按头的尺寸算
    let headMesh = null;
    mesh.traverse((o) => { if (o.isMesh && o.name === 'head') headMesh = o; });
    const hb = headMesh ? new THREE.Box3().setFromObject(headMesh) : bb;
    const hc = hb.getCenter(new THREE.Vector3());
    const hr = 0.5 * Math.hypot(hb.max.x - hb.min.x, hb.max.y - hb.min.y, hb.max.z - hb.min.z);
    const DH = (Math.max(hr, h * 0.24) / Math.sin((30 * Math.PI) / 360)) * 1.5;

    function shot(tag, v) {
      const c3 = v.t === 'head' ? hc : (v.t === 'at' ? v.c : bodyC);
      const dist = v.t === 'head' ? DH : (v.t === 'at' ? v.d : D);
      const rad = (v.a * Math.PI) / 180;
      const flat = dist * Math.cos(v.el);
      cam.position.set(
        c3.x + Math.sin(rad) * flat,
        c3.y + dist * Math.sin(v.el),
        c3.z + Math.cos(rad) * flat
      );
      cam.lookAt(c3);
      renderer.render(scene, cam);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g2 = c.getContext('2d');
      g2.drawImage(renderer.domElement, 0, 0);
      g2.font = '13px monospace';
      g2.fillStyle = '#12212e';
      g2.fillText(type + ' ' + tag, 6, 16);
      return c;
    }

    // 摆腿只影响后面几张，所以放在没摆腿的机位拍完之后
    const calm = VIEWS.filter((v) => !v.swing);
    const swung = VIEWS.filter((v) => v.swing);
    let shots = [];

    if (cfg.ISOLATE) {
      // 逐块隔离：一次只显示一块，单独对焦拍下来 —— 哪一块画错了直接看出来。
      // 按 mesh 而不是按 group 开关：猪鼻子挂在头下面，把头的 group 藏了鼻子也一起没了。
      const pms = [];
      mesh.traverse((o) => { if (o.isMesh) pms.push(o); });
      shots = pms.map((pm, i) => {
        for (const other of pms) other.visible = other === pm;
        const b = new THREE.Box3().setFromObject(pm);
        const c = b.getCenter(new THREE.Vector3());
        const rr = 0.5 * Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
        const dd = (Math.max(rr, 0.02) / Math.sin((30 * Math.PI) / 360)) * 1.6;
        return shot((pm.name || '?') + '#' + i, { a: 30, el: 0.25, t: 'at', c, d: dd });
      });
      for (const pm of pms) pm.visible = true;
      shots.unshift(shot('all', { a: 38, el: 0.4, t: 'at', c: bodyC, d: D }));
    } else {
      shots = calm.map((v) => shot(v.tag, v));
      if (swung.length) {
        for (const pg of mesh.userData.legs) pg.rotation.x = (pg.userData.restX || 0) + 0.7;
        for (const pg of mesh.userData.legsB) pg.rotation.x = (pg.userData.restX || 0) - 0.7;
        for (const pg of mesh.userData.arms) pg.rotation.x = (pg.userData.restX || 0) - 0.5;
        for (const pg of mesh.userData.armsB) pg.rotation.x = (pg.userData.restX || 0) + 0.5;
        for (const v of swung) shots.push(shot(v.tag, v));
      }
    }

    const rows = Math.ceil(shots.length / COLS);
    const strip = document.createElement('canvas');
    strip.width = W * COLS; strip.height = H * rows;
    const sg = strip.getContext('2d');
    sg.fillStyle = '#8fbcd4';
    sg.fillRect(0, 0, strip.width, strip.height);
    shots.forEach((c, i) => sg.drawImage(c, (i % COLS) * W, Math.floor(i / COLS) * H));
    out[type] = strip.toDataURL('image/png');

    scene.remove(mesh);
  }
  return { out, report };
}

const ALL_VIEWS = [
  { tag: 'front', a: 0, el: 0.05, t: 'body' },
  { tag: 'right', a: 90, el: 0.05, t: 'body' },
  { tag: 'back', a: 180, el: 0.05, t: 'body' },
  { tag: 'left', a: 270, el: 0.05, t: 'body' },
  { tag: '3/4', a: 38, el: 0.40, t: 'body' },
  { tag: 'head-front', a: 0, el: 0.10, t: 'head' },
  { tag: 'head-left', a: 270, el: 0.08, t: 'head' },
  { tag: 'head-3/4', a: 42, el: 0.18, t: 'head' },
  { tag: 'swing-right', a: 90, el: 0.05, t: 'body', swing: true },
  { tag: 'swing-3/4', a: 42, el: 0.35, t: 'body', swing: true }
];

const wantViews = VIEWS ? VIEWS.split(',').map((s) => s.trim()) : null;
const views = wantViews ? ALL_VIEWS.filter((v) => wantViews.includes(v.tag)) : ALL_VIEWS;
// 生物清单直接从 mobtex.js 的 MODEL 表里抓，免得两处各写一份对不上
const SRC = fs.readFileSync(path.join(process.cwd(), 'js', 'mobtex.js'), 'utf8');
const MODEL_KEYS = [...SRC.matchAll(/^  ([a-z_]+): \{$/gm)].map((m) => m[1]);
if (!MODEL_KEYS.length) throw new Error('没能从 js/mobtex.js 里解析出 MODEL 的表项');
const order = ONLY ? MODEL_KEYS.filter((t) => ONLY.split(',').map((s) => s.trim()).includes(t)) : MODEL_KEYS;

const res = await ev(`(${shootAll.toString()})(${JSON.stringify({ W, H, COLS, ORDER: order, VIEWS: views, ISOLATE })})`);

fs.mkdirSync(OUT, { recursive: true });
for (const [type, dataUrl] of Object.entries(res.out)) {
  fs.writeFileSync(path.join(OUT, 'mobview-' + type + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
}

console.log('==== 转台渲染 ====');
for (const [type, r] of Object.entries(res.report)) {
  if (r.error) { console.log(type + '  ' + r.error); continue; }
  const w = r.world;
  console.log(
    type.padEnd(9) +
    '盒子' + (w.x + 'x' + w.y + 'x' + w.z).padEnd(20) +
    '判定框' + (r.hitbox[0] + 'x' + r.hitbox[1]).padEnd(9) +
    '离地' + String(w.minY).padEnd(7) +
    '块' + String(r.meshes).padEnd(3) + '面' + String(r.tris).padEnd(5) +
    '腿' + r.ud.legs + '/' + r.ud.legsB + ' 臂' + r.ud.arms + ' 材质' + r.ud.mats
  );
  const byName = {};
  for (const p of r.partY) {
    if (!byName[p.name]) byName[p.name] = [];
    byName[p.name].push(p.lo.toFixed(2) + '~' + p.hi.toFixed(2));
  }
  console.log('          ' + Object.entries(byName).map(([k, v]) => k + '[' + v.join(' ') + ']').join(' '));
}
if (errors.length) {
  console.log('\nJS 报错:');
  for (const e of errors.slice(0, 10)) console.log('  ' + e);
}

chrome.kill();
