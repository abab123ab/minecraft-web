import * as THREE from './vendor/three.module.js';
import { buildAtlas, ASSET_COUNT, tileUV, TILE_INDEX } from './textures.js';
import { BLOCKS, AIR, breakTime, canHarvest } from './blocks.js';
import { ITEMS, ITEM_BY_KEY, FIST_ATTACK } from './items.js';
import { World } from './world.js';
import { CHUNK, HEIGHT, SEA } from './worlddef.js';
import { terrainHeight } from './worldgen.js';
import { Sky, SLEEP_SPEED, SKY_DAY } from './sky.js';
import { makeFurnace, tickFurnaces } from './furnace.js';
import { updateHud } from './hudview.js';
import { Player, P_WIDTH, P_HEIGHT } from './player.js';
import { DroppedItems } from './entities.js';
import { Inventory, HOTBAR_SIZE, INV_SIZE, ARMOR_SIZE } from './inventory.js';
import { UI } from './ui.js';
import { Survival, EXHAUST, MAX_HUNGER, MAX_HEALTH } from './survival.js';
import { Sfx } from './sfx.js';
import { Hud } from './hud.js';
import { MobManager } from './mobs.js';
import { buildMobArt } from './mobtex.js';
import { Particles } from './particles.js';
import { loadSave, saveGame, clearSave, restoreInventory, restoreFurnaces } from './save.js';

const REACH = 5;
const ATTACK_REACH = 3.2;
const ATTACK_COOLDOWN = 0.5;
// 连锁挖矿的上限：一条矿脉最多 48 格，一棵树最多 96 格原木
const ORE_CHAIN_LIMIT = 48;
const LOG_CHAIN_LIMIT = 96;

class Game {
  get isDay() { return this.sky.isDay; }
  get isNight() { return this.sky.isNight; }
  get lightLevel() { return this.sky.light; }
  get timeOfDay() { return this.sky.timeOfDay; }
  set timeOfDay(v) { this.sky.timeOfDay = v; }

  constructor(atlasCanvas, save) {
    this.canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_DAY);
    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.08, 1200);

    this.atlasCanvas = atlasCanvas;
    this.world = new World(this.scene, this.atlasCanvas, save ? save.edits : null);
    this.player = new Player(this.world);
    this.dropped = new DroppedItems(this.scene, this.world, this.atlasCanvas);
    this.inventory = new Inventory();
    this.cursor = null;
    this.craft2 = new Array(4).fill(null);
    this.craft3 = new Array(9).fill(null);
    this.furnaces = new Map();

    this.ui = new UI(this);
    this.survival = new Survival();
    this.hud = new Hud();
    this.mobs = new MobManager(this.scene, this.world, this.camera);
    this.sfx = new Sfx();
    this.mobs.sfx = this.sfx;
    this.particles = new Particles(this.scene, this.world.atlasTexture);
    this.sky = new Sky(this.scene, this.camera, this.world);
    this.attackCd = 0;
    this.deathShown = false;
    this.input = {
      forward: false, back: false, left: false, right: false,
      jump: false, sneak: false, sprint: false
    };
    this.mining = false;
    this.mineState = null;
    this.sprintTap = false;
    this.ctrlSprint = false;
    this.lastWUp = -1e9;
    this.started = false;
    this.sensitivity = 0.0022;
    this.fpsAcc = 0;
    this.fpsCount = 0;
    this.fps = 0;
    this.autoTune = true;
    this.tuneTimer = 0;
    this.warmup = 0;
    this.stepTimer = 0;
    this.lastHealth = MAX_HEALTH;
    this.sleeping = false;

    this.buildHighlight();
    this.bindEvents();
    this.spawnPlayer();
    if (save) this.applySave(save);
    else this.giveStartKit();

    this.debugEl = document.getElementById('debug');
    this.coordEl = document.getElementById('coord');
    this.handEl = document.getElementById('hand');
    this.lastHandId = -1;
    this.mineBar = document.getElementById('minebar');
    this.mineFill = document.getElementById('minefill');
    this.hurtFlashEl = document.getElementById('hurt-flash');

    this.ui.render();
    this.last = performance.now();
    requestAnimationFrame(() => this.loop());
  }

  safePointerLock() {
    try {
      const r = this.canvas.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {}
  }

  buildHighlight() {
    const g = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    const e = new THREE.EdgesGeometry(g);
    this.highlight = new THREE.LineSegments(e, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }));
    this.highlight.visible = false;
    this.highlight.renderOrder = 4;
    this.scene.add(this.highlight);

    this.crackGeo = new THREE.BoxGeometry(1.01, 1.01, 1.01);
    this.crackMesh = new THREE.Mesh(this.crackGeo, new THREE.MeshBasicMaterial({
      map: this.world.atlasTexture, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }));
    this.crackMesh.visible = false;
    this.crackMesh.renderOrder = 3;
    this.crackStage = -1;
    this.scene.add(this.crackMesh);
  }

  setCrackStage(stage) {
    if (stage === this.crackStage) return;
    this.crackStage = stage;
    const uv = this.crackGeo.attributes.uv;
    const { u0, v0, u1, v1 } = tileUV(TILE_INDEX['crack_' + stage]);
    const a = uv.array;
    for (let f = 0; f < 6; f++) {
      const o = f * 8;
      a[o] = u0; a[o + 1] = v1;
      a[o + 2] = u1; a[o + 3] = v1;
      a[o + 4] = u0; a[o + 5] = v0;
      a[o + 6] = u1; a[o + 7] = v0;
    }
    uv.needsUpdate = true;
  }

  hideMineOverlay() {
    this.highlight.visible = false;
    this.crackMesh.visible = false;
    this.mineBar.style.display = 'none';
    this.mineState = null;
  }

  giveStartKit() {
    this.inventory.add(ITEM_BY_KEY.wooden_pickaxe.id, 1);
    this.inventory.add(ITEM_BY_KEY.wooden_axe.id, 1);
    this.inventory.add(ITEM_BY_KEY.apple.id, 3);
  }

  applySave(s) {
    const p = s.player;
    if (p) {
      this.player.pos.set(p.x, p.y, p.z);
      this.player.vel.set(0, 0, 0);
      this.player.targetYaw = this.player.yaw = p.yaw;
      this.player.targetPitch = this.player.pitch = p.pitch;
      this.player.flying = !!p.flying;
      this.player.fallDistance = 0;
      this.player.lastGroundY = p.y;
      this.player.onGround = false;
      if (p.spawn) this.spawnPoint.set(p.spawn.x, p.spawn.y, p.spawn.z);
    }
    const v = s.survival;
    if (v) {
      this.survival.health = v.health;
      this.survival.hunger = v.hunger;
      this.survival.saturation = v.saturation;
      this.survival.exhaustion = v.exhaustion;
      this.survival.airSupply = v.airSupply;
      this.survival.dead = false;
      this.survival.regenTimer = 0;
      this.survival.starveTimer = 0;
      this.survival.drownTimer = 0;
    }
    restoreInventory(this.inventory, s.inventory, INV_SIZE, ARMOR_SIZE);
    restoreFurnaces(this, s.furnaces);
    if (typeof s.time === 'number') this.timeOfDay = s.time;
    this.lastHealth = this.survival.health;

    const cx = Math.floor(this.player.pos.x / CHUNK), cz = Math.floor(this.player.pos.z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.world.ensureChunk(cx + dx, cz + dz);
    for (const ch of this.world.dirty) this.world.buildMesh(ch);
    this.world.dirty.clear();
    this.ui.render();
  }

  spawnPlayer() {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.world.ensureChunk(dx, dz);
    }
    for (const ch of this.world.dirty) this.world.buildMesh(ch);
    this.world.dirty.clear();
    let y = terrainHeight(0, 0) + 1;
    if (y < SEA) y = SEA + 1;
    this.player.pos.set(0.5, y + 0.2, 0.5);
    this.player.vel.set(0, 0, 0);
    this.player.fallDistance = 0;
    this.player.lastGroundY = this.player.pos.y;
    this.player.onGround = false;
    this.spawnPoint = this.player.pos.clone();
  }

  bindEvents() {
    const overlay = document.getElementById('start');
    const btn = document.getElementById('start-btn');
    const rdSel = document.getElementById('rd');
    btn.addEventListener('click', () => {
      this.started = true;
      overlay.classList.add('hidden');
      this.sfx.resume();
      this.safePointerLock();
    });
    if (rdSel) {
      rdSel.addEventListener('change', () => this.setRenderDistance(parseInt(rdSel.value, 10)));
      this.world.renderDistance = parseInt(rdSel.value, 10);
    }
    const aoSel = document.getElementById('noao');
    if (aoSel) {
      aoSel.addEventListener('change', () => this.setAO(!aoSel.checked));
    }
    this.sky.setFog(this.world.renderDistance * CHUNK);

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      this.locked = locked;
      if (!locked && this.started && !this.ui.isOpen()) overlay.classList.remove('hidden');
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.sleeping) return;
      this.player.look(e.movementX, e.movementY, this.sensitivity);
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mining = true; this.mineState = null; }
      if (e.button === 2) this.useItem();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.mining = false; this.mineState = null; }
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      const d = e.deltaY > 0 ? 1 : -1;
      this.inventory.selected = (this.inventory.selected + d + HOTBAR_SIZE) % HOTBAR_SIZE;
      this.ui.render();
    });

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('resize', () => this.onResize());
    setInterval(() => { if (this.started) saveGame(this); }, 10000);
    window.addEventListener('beforeunload', () => { if (this.started) saveGame(this); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.started) saveGame(this);
    });
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  onKey(e, down) {
    const code = e.code;
    if (code === 'KeyW') {
      if (down) {
        if (performance.now() - this.lastWUp <= 300) this.sprintTap = true;
        this.input.forward = true;
      } else {
        this.lastWUp = performance.now();
        this.sprintTap = false;
        this.input.forward = false;
      }
    } else if (code === 'KeyS') this.input.back = down;
    else if (code === 'KeyA') this.input.left = down;
    else if (code === 'KeyD') this.input.right = down;
    else if (code === 'Space') { this.input.jump = down; e.preventDefault(); }
    else if (code === 'ShiftLeft' || code === 'ShiftRight') this.input.sneak = down;
    else if (code === 'ControlLeft' || code === 'ControlRight') this.ctrlSprint = down;
    if (!down) return;
    if (code === 'KeyE') {
      if (this.ui.isOpen()) this.ui.close();
      else { this.ui.open('inventory'); document.exitPointerLock(); }
    } else if (code === 'KeyF') {
      this.player.flying = !this.player.flying;
      this.ui.showHint(this.player.flying ? '飞行模式：开' : '飞行模式：关');
    } else if (code === 'KeyQ') {
      // 界面开着时丢鼠标悬停的那格，否则丢手持那格；按住 Ctrl 丢整组
      if (this.ui.isOpen()) this.ui.dropHovered(e.ctrlKey);
      else this.dropOne(e.ctrlKey);
    } else if (code === 'KeyR') {
      this.cycleRenderDistance();
    } else if (code === 'KeyO') {
      this.setAO(!this.world.useAO);
    } else if (code === 'KeyM') {
      const muted = this.sfx.toggleMute();
      this.ui.showHint(muted ? '已静音' : '声音：开');
    } else if (code.startsWith('Digit')) {
      const n = parseInt(code.slice(5), 10);
      if (n >= 1 && n <= 9) {
        this.inventory.selected = n - 1;
        this.ui.render();
      }
    }
  }

  onScreenClosed() {
    this.ui.render();
    if (this.started) this.safePointerLock();
  }

  eatHeld(item) {
    if (!this.survival.eat(item.food)) return;
    this.inventory.removeAt(this.inventory.selected, 1);
    this.sfx.eat();
    this.ui.showHint('吃了 ' + item.label + '，饥饿 +' + item.food.hunger);
    this.ui.render();
  }

  // 吸掉落物：同一帧吸到的东西合并成一行提示 + 一声音效 + 一次重绘。
  // 原来是每堆各来一遍 —— 一条 48 格的矿脉同时吸过来就是几十声重叠音、几十次全量重绘。
  collectDrops(dt) {
    const picked = new Map();
    this.dropped.update(dt, this.player.pos, this.inventory, (id, n) => {
      picked.set(id, (picked.get(id) || 0) + n);
    });
    if (picked.size === 0) return;
    const parts = [];
    for (const [id, n] of picked) parts.push('+' + n + ' ' + ITEMS[id].label);
    this.sfx.pickup();
    this.ui.showHint(parts.join('　'));
    this.ui.render();
  }

  dropOne(whole) {
    const i = this.inventory.selected;
    const s = this.inventory.slots[i];
    if (!s) return;
    const n = this.inventory.removeAt(i, whole ? s.count : 1);
    if (n > 0) this.spawnDrop(s.id, n);
    this.ui.render();
  }

  dropStack(stack) {
    this.spawnDrop(stack.id, stack.count);
  }

  spawnDrop(itemId, count) {
    const p = this.player;
    const dir = this.lookDir();
    this.dropped.spawn(itemId, count, p.pos.x + dir.x * 0.6, p.pos.y + 1.2, p.pos.z + dir.z * 0.6, {
      x: dir.x * 3.5, y: 2.2, z: dir.z * 3.5
    });
  }

  lookDir() {
    const p = this.player;
    const cp = Math.cos(p.pitch);
    return new THREE.Vector3(-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp);
  }

  groundSoundAt(pos) {
    const x = Math.floor(pos.x), y = Math.floor(pos.y) - 1, z = Math.floor(pos.z);
    const b = BLOCKS[this.world.getBlock(x, y, z)];
    return (b && b.sound) ? b.sound : 'stone';
  }

  setRenderDistance(rd) {
    this.world.renderDistance = rd;
    this.sky.setFog(this.world.renderDistance * CHUNK);
    const sel = document.getElementById('rd');
    if (sel) sel.value = String(rd);
    this.ui.showHint('渲染距离 ' + rd + '（按 R 继续调）');
  }

  setAO(on) {
    this.world.useAO = on;
    for (const ch of this.world.chunks.values()) this.world.markDirty(ch.cx, ch.cz);
    const box = document.getElementById('noao');
    if (box) box.checked = !on;
    this.ui.showHint(on ? '环境光遮蔽：开' : '流畅模式：开（关遮蔽）');
  }

  cycleRenderDistance() {
    const steps = [2, 3, 4, 6, 8];
    const cur = this.world.renderDistance;
    let next = steps[0];
    for (const s of steps) { if (s > cur) { next = s; break; } }
    this.setRenderDistance(next);
  }

  hitTest() {
    const eye = this.player.eyePos();
    return this.world.raycast(eye, this.lookDir(), REACH);
  }

  useItem() {
    const held = this.inventory.held();
    if (held) {
      const heldItem = ITEMS[held.id];
      if (heldItem.food && this.survival.hunger < MAX_HUNGER) { this.eatHeld(heldItem); return; }
    }
    const hit = this.hitTest();
    if (!hit) return;
    const block = BLOCKS[hit.id];
    if (block.key === 'crafting_table') {
      this.ui.open('crafting');
      document.exitPointerLock();
      return;
    }
    if (block.key === 'furnace') {
      const k = hit.x + ',' + hit.y + ',' + hit.z;
      if (!this.furnaces.has(k)) {
        this.furnaces.set(k, makeFurnace());
      }
      this.ui.open('furnace', this.furnaces.get(k));
      document.exitPointerLock();
      return;
    }
    if (block.key === 'bed') {
      this.trySleep(hit);
      return;
    }

    const stack = this.inventory.held();
    if (!stack) return;
    const item = ITEMS[stack.id];
    if (item.food && this.survival.hunger < MAX_HUNGER) { this.eatHeld(item); return; }
    if (!item.blockId) return;
    if (this.input.sneak === true && (block.key === 'crafting_table' || block.key === 'furnace')) return;

    const bx = hit.x + hit.nx, by = hit.y + hit.ny, bz = hit.z + hit.nz;
    const cur = this.world.getBlock(bx, by, bz);
    if (cur !== AIR && !BLOCKS[cur].liquid) return;
    if (this.intersectsPlayer(bx, by, bz)) return;
    if (by < 0 || by >= HEIGHT) return;
    if (item.key === 'torch') {
      if (!BLOCKS[this.world.getBlock(bx, by - 1, bz)].solid) return;
      if (hit.ny !== 1) return;
    }
    this.world.setBlock(bx, by, bz, item.blockId);
    this.inventory.consumeHeld(1);
    const placed = BLOCKS[item.blockId];
    if (placed) this.sfx.place(placed);
    this.ui.render();
  }

  trySleep(hit) {
    if (this.sleeping || this.survival.dead) return;
    if (!this.isNight) {
      this.ui.showHint('现在还不是晚上睡觉的时候');
      return;
    }
    this.spawnPoint.set(hit.x + 0.5, hit.y + 1, hit.z + 0.5);
    this.player.pos.set(hit.x + 0.5, hit.y + 1, hit.z + 0.5);
    this.player.vel.set(0, 0, 0);
    this.player.flying = false;
    this.player.onGround = true;
    this.player.fallDistance = 0;
    this.player.lastGroundY = this.player.pos.y;
    this.sleeping = true;
    const el = document.getElementById('sleep');
    if (el) el.classList.add('on');
    this.ui.showHint('你睡着了…天快亮了');
  }

  wake() {
    this.sleeping = false;
    const el = document.getElementById('sleep');
    if (el) el.classList.remove('on');
    this.ui.showHint('早上好');
  }

  intersectsPlayer(bx, by, bz) {
    const p = this.player;
    const h = P_WIDTH / 2;
    return (bx + 1 > p.pos.x - h && bx < p.pos.x + h &&
      by + 1 > p.pos.y && by < p.pos.y + P_HEIGHT &&
      bz + 1 > p.pos.z - h && bz < p.pos.z + h);
  }

  breakBlock(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const block = BLOCKS[id];
    if (id === AIR) return;
    const held = this.inventory.held();
    const toolDef = held ? ITEMS[held.id].tool : null;
    const harvest = canHarvest(block, toolDef);

    const plan = this.chainPlan(x, y, z, id, block);
    // 按物品种类合并：一条 48 格的脉掉 1 堆，而不是 48 个独立实体
    const tally = new Map();
    let sound = true;
    for (const [bx, by, bz] of plan.blocks) {
      const b = BLOCKS[this.world.getBlock(bx, by, bz)] || block;
      // 一次连锁只响一声，否则几十格会在同一帧叠几十个音效
      this.mineBlock(bx, by, bz, b, harvest, sound, tally);
      sound = false;
      if (toolDef) {
        // 耐久按实际挖掉的格数扣。中途挖断了就停手，剩下的留给玩家换把镐子
        this.inventory.damageHeld(1);
        if (!this.inventory.held()) break;
      }
    }
    // 清掉的树叶是纯装饰：不掉物、不出声、也不掷苹果
    for (const [bx, by, bz] of plan.clear) this.world.setBlock(bx, by, bz, AIR);

    for (const [dropId, count] of tally) {
      this.dropped.spawn(dropId, count, x + 0.5, y + 0.4, z + 0.5, null);
    }

    this.survival.addExhaustion(EXHAUST.mine);
    this.ui.render();
  }

  // 挖这一格该连带哪些格：矿 → 同种矿脉；原木 → 整棵树（含要清掉的树叶）；其余 → 就它自己
  chainPlan(x, y, z, id, block) {
    if (block.ore) return { blocks: this.collectOreVein(x, y, z, id, ORE_CHAIN_LIMIT), clear: [] };
    if (block.key === 'log' || block.key === 'spruce_log') return this.planTree(x, y, z, id);
    return { blocks: [[x, y, z]], clear: [] };
  }

  // 树干用连通原木（和矿脉同一套 flood fill）；树叶按树干包围盒外扩 3 格清掉。
  // 外扩 5 格内如果还有别的树桩，那附近的树叶就留着 —— 否则砍一棵会把旁边那棵也剃秃。
  planTree(x, y, z, id) {
    const logs = this.collectOreVein(x, y, z, id, LOG_CHAIN_LIMIT);
    let minX = x, maxX = x, minZ = z, maxZ = z, minY = y, maxY = y;
    for (const [bx, by, bz] of logs) {
      if (bx < minX) minX = bx;
      if (bx > maxX) maxX = bx;
      if (bz < minZ) minZ = bz;
      if (bz > maxZ) maxZ = bz;
      if (by < minY) minY = by;
      if (by > maxY) maxY = by;
    }
    const own = new Set(logs.map((c) => c[0] + ',' + c[1] + ',' + c[2]));
    const otherTrunks = [];
    const leaves = [];
    for (let cz = minZ - 5; cz <= maxZ + 5; cz++) {
      for (let cx = minX - 5; cx <= maxX + 5; cx++) {
        for (let cy = minY; cy <= maxY + 3; cy++) {
          const b = BLOCKS[this.world.getBlock(cx, cy, cz)];
          if (!b) continue;
          const dx = Math.max(minX - cx, cx - maxX, 0);
          const dz = Math.max(minZ - cz, cz - maxZ, 0);
          if (b.key === 'log' || b.key === 'spruce_log') {
            if (!own.has(cx + ',' + cy + ',' + cz)) otherTrunks.push([cx, cy, cz]);
          } else if ((b.key === 'leaves' || b.key === 'spruce_leaves') && dx <= 3 && dz <= 3) {
            leaves.push([cx, cy, cz]);
          }
        }
      }
    }
    const clear = otherTrunks.length === 0 ? leaves : leaves.filter(([lx, ly, lz]) =>
      !otherTrunks.some(([fx, fy, fz]) =>
        Math.abs(fx - lx) <= 2 && Math.abs(fy - ly) <= 2 && Math.abs(fz - lz) <= 2));
    return { blocks: logs, clear };
  }

  collectOreVein(x, y, z, id, limit) {
    const found = [];
    const seen = new Set();
    const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const queue = [[x, y, z]];
    seen.add(x + ',' + y + ',' + z);
    while (queue.length && found.length < limit) {
      const cur = queue.shift();
      const cx = cur[0], cy = cur[1], cz = cur[2];
      if (this.world.getBlock(cx, cy, cz) !== id) continue;
      found.push([cx, cy, cz]);
      for (let i = 0; i < 6; i++) {
        const nx = cx + DIRS[i][0], ny = cy + DIRS[i][1], nz = cz + DIRS[i][2];
        const key = nx + ',' + ny + ',' + nz;
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.world.getBlock(nx, ny, nz) === id) queue.push([nx, ny, nz]);
      }
    }
    return found;
  }

  mineBlock(x, y, z, block, harvest, sound, tally) {
    this.world.setBlock(x, y, z, AIR);
    if (block.tiles) this.particles.burst(x, y, z, block.tiles[1] || block.tiles[0], 10);
    if (!block.unbreakable && sound) this.sfx.breakBlock(block);
    if (harvest && block.drop !== null) {
      const dropKey = block.drop || block.key;
      const it = ITEM_BY_KEY[dropKey];
      if (it) tally.set(it.id, (tally.get(it.id) || 0) + (block.dropCount || 1));
    }
    if (block.bonusDrop && Math.random() < block.bonusDrop.chance) {
      const bonus = ITEM_BY_KEY[block.bonusDrop.key];
      if (bonus) tally.set(bonus.id, (tally.get(bonus.id) || 0) + 1);
    }
  }

  updateAttack(dt) {
    if (this.attackCd > 0) this.attackCd -= dt;
    if (!this.mining || this.attackCd > 0 || this.survival.dead) return false;
    const eye = this.player.eyePos();
    const dir = this.lookDir();
    const mob = this.mobs.raycast(eye, dir, ATTACK_REACH);
    if (!mob) return false;
    const hit = this.hitTest();
    if (hit) {
      const bd = Math.hypot(hit.x + 0.5 - eye.x, hit.y + 0.5 - eye.y, hit.z + 0.5 - eye.z);
      if (bd < mob.pos.distanceTo(eye)) return false;
    }
    this.attackCd = ATTACK_COOLDOWN;
    const knock = new THREE.Vector3(dir.x, 0, dir.z);
    if (knock.lengthSq() > 0) knock.normalize();
    mob.hurt(this.attackDamage(), knock);
    this.survival.addExhaustion(EXHAUST.attack);
    const held = this.inventory.held();
    if (held && ITEMS[held.id].tool) {
      this.inventory.damageHeld(1);
      this.ui.render();
    }
    return true;
  }

  attackDamage() {
    const held = this.inventory.held();
    if (!held) return FIST_ATTACK;
    return ITEMS[held.id].attack || FIST_ATTACK;
  }

  updateMobs(dt) {
    this.mobs.update(dt, this.player, {
      isNight: this.isNight,
      isDay: this.isDay,
      light: this.lightLevel,
      onPlayerHit: (dmg) => this.onMobHit(dmg),
      spawnDrop: (key, x, y, z) => this.spawnDropByKey(key, x, y, z)
    });
  }

  onMobHit(dmg) {
    if (this.survival.dead) return;
    this.survival.takeDamage(dmg);
    this.flashHurt();
  }

  flashHurt() {
    const el = this.hurtFlashEl;
    if (!el) return;
    el.classList.add('on');
    clearTimeout(this.hurtTimer);
    this.hurtTimer = setTimeout(() => el.classList.remove('on'), 90);
  }

  spawnDropByKey(key, x, y, z) {
    const it = ITEM_BY_KEY[key];
    if (it) this.dropped.spawn(it.id, 1, x, y, z, null);
  }

  updateMining(dt) {
    if (!this.mining || this.ui.isOpen()) {
      this.hideMineOverlay();
      return;
    }
    const hit = this.hitTest();
    if (!hit) {
      this.hideMineOverlay();
      return;
    }
    this.highlight.visible = true;
    this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    this.crackMesh.position.copy(this.highlight.position);

    const block = BLOCKS[hit.id];
    if (block.unbreakable) {
      this.mineState = null;
      this.mineBar.style.display = 'none';
      this.crackMesh.visible = false;
      return;
    }

    if (!this.mineState || this.mineState.x !== hit.x || this.mineState.y !== hit.y || this.mineState.z !== hit.z) {
      const held = this.inventory.held();
      const toolDef = held ? ITEMS[held.id].tool : null;
      const total = breakTime(block, toolDef);
      this.mineState = { x: hit.x, y: hit.y, z: hit.z, progress: 0, total, id: hit.id };
      if (!canHarvest(block, toolDef)) {
        const mats = { 1: '木', 2: '石', 3: '铁', 4: '钻石' };
        const kinds = { pickaxe: '镐', axe: '斧', shovel: '铲' };
        this.ui.showHint('需要' + (mats[block.tier] || '') + (kinds[block.tool] || '工具') + '才能掉落物品');
      }
    }
    const m = this.mineState;
    m.progress += dt;
    const pct = Math.min(1, m.progress / m.total);
    this.mineBar.style.display = 'block';
    this.mineFill.style.width = (pct * 100) + '%';
    this.crackMesh.visible = pct > 0;
    if (this.crackMesh.visible) this.setCrackStage(Math.min(9, Math.floor(pct * 10)));
    if (m.progress >= m.total) {
      this.breakBlock(m.x, m.y, m.z);
      this.mineState = null;
      this.mineBar.style.display = 'none';
      this.crackMesh.visible = false;
    }
  }

  updateFurnaces(dt) {
    tickFurnaces(this, dt);
  }

  updateDayNight(dt) {
    this.sky.update(dt);
  }

  loop() {
    const now = performance.now();
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.1) dt = 0.1;

    this.fpsAcc += dt;
    this.fpsCount++;
    if (this.fpsAcc >= 0.5) {
      this.fps = Math.round(this.fpsCount / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsCount = 0;
    }

    if (this.started) {
      this.warmup += dt;
      const active = !this.ui.isOpen() && !this.survival.dead;
      const canAct = active && !this.sleeping;
      this.input.sprint = this.ctrlSprint || this.sprintTap;
      this.player.canSprint = this.survival.canSprint();
      if (canAct) this.player.update(dt, this.input);
      else this.player.update(dt, {});
      if (canAct && this.player.onGround && !this.player.flying) {
        const hs = Math.hypot(this.player.vel.x, this.player.vel.z);
        if (hs > 0.6) {
          this.stepTimer -= dt;
          if (this.stepTimer <= 0) {
            this.sfx.step(this.groundSoundAt(this.player.pos));
            this.stepTimer = this.player.sprinting ? 0.30 : 0.45;
          }
        } else this.stepTimer = 0;
      } else this.stepTimer = 0;
      if (canAct && this.player.justLanded && this.player.landedFall > 1.5) this.sfx.land();
      this.updateSurvival(dt);
      if (this.survival.health < this.lastHealth - 0.01 && !this.survival.dead) this.sfx.hurt();
      this.lastHealth = this.survival.health;
      if (canAct) this.updateMobs(dt);
      const attacked = canAct ? this.updateAttack(dt) : false;
      if (attacked) this.hideMineOverlay();
      else this.updateMining(canAct ? dt : 0);
      this.collectDrops(dt);
      this.updateFurnaces(dt);
      this.particles.update(dt);
      this.ui.tick(dt);
      this.autoTuneQuality(dt);
      this.sky.updateFov(dt, this.player.sprinting);
      if (this.survival.dead && !this.deathShown) this.showDeath();
    }

    if (this.player.pos.y < -10) {
      this.player.pos.copy(this.spawnPoint);
      this.player.vel.set(0, 0, 0);
    }

    this.world.update(this.player.pos.x, this.player.pos.z, 4);
    if (this.sleeping) {
      this.updateDayNight(dt * SLEEP_SPEED);
      if (this.isDay) this.wake();
    } else {
      this.updateDayNight(dt);
    }
    this.player.applyToCamera(this.camera);

    updateHud(this);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.loop());
  }

  updateSurvival(dt) {
    const p = this.player;
    const flying = p.flying;
    this.survival.update(dt, {
      distance: flying ? 0 : p.movedDistance,
      sprinting: p.sprinting,
      sneaking: p.sneaking,
      swimming: p.inWater && !flying,
      jumped: p.jumped,
      sprintJumped: p.jumped && p.sprinting,
      headInWater: p.headInWater && !flying,
      landedFall: (p.justLanded && !p.inWater) ? p.landedFall : 0
    });
  }

  showDeath() {
    this.deathShown = true;
    document.exitPointerLock();
    const el = document.getElementById('death');
    if (el) el.classList.remove('hidden');
  }

  respawn() {
    this.survival.reset();
    this.lastHealth = this.survival.health;
    this.mobs.clear();
    this.particles.clear();
    this.player.pos.copy(this.spawnPoint);
    this.player.vel.set(0, 0, 0);
    this.player.fallDistance = 0;
    this.player.lastGroundY = this.spawnPoint.y;
    this.deathShown = false;
    const el = document.getElementById('death');
    if (el) el.classList.add('hidden');
    this.ui.render();
    this.safePointerLock();
  }

  autoTuneQuality(dt) {
    if (!this.autoTune || this.warmup < 12) return;
    this.tuneTimer += dt;
    if (this.tuneTimer < 5) return;
    this.tuneTimer = 0;
    if (this.fps < 28 && this.world.renderDistance > 2) {
      const next = Math.max(2, this.world.renderDistance - 1);
      this.setRenderDistance(next);
      this.ui.showHint('检测到卡顿，渲染距离自动降到 ' + next + '（按 R 手动调）');
    } else if (this.fps < 28 && this.world.useAO) {
      this.setAO(false);
    }
  }

}

window.addEventListener('DOMContentLoaded', async () => {
  const btn = document.getElementById('start-btn');
  const tip = document.getElementById('load-tip');
  try {
    const atlas = await buildAtlas();
    await buildMobArt();
    const save = loadSave();
    window.game = new Game(atlas, save);
    const rb = document.getElementById('respawn-btn');
    if (rb) rb.addEventListener('click', () => window.game.respawn());
    const wipe = document.getElementById('wipe-btn');
    if (wipe) {
      wipe.addEventListener('click', () => { clearSave(); location.reload(); });
      if (save) wipe.classList.remove('hidden');
    }
    btn.disabled = false;
    btn.textContent = '点击开始游戏';
    if (tip) tip.textContent = '原版贴图已就绪（' + ASSET_COUNT + ' 张）' + (save ? ' · 已载入上次存档' : '');
  } catch (err) {
    btn.textContent = '加载失败';
    if (tip) {
      tip.textContent = '贴图加载失败：' + err.message +
        '。请确认通过 http 打开（不是双击 file://），且 textures/ 目录存在。';
    }
    console.error(err);
  }
});
