import * as THREE from './vendor/three.module.js';
import { buildAtlas, ASSET_COUNT, tileUV, TILE_INDEX } from './textures.js';
import { BLOCKS, AIR, breakTime, canHarvest } from './blocks.js';
import { ITEMS, ITEM_BY_KEY, FIST_ATTACK, armorStats, itemIconCanvas } from './items.js';
import { World, terrainHeight, biomeAt, CHUNK, HEIGHT, SEA } from './world.js';
import { Player, P_WIDTH, P_HEIGHT } from './player.js';
import { DroppedItems } from './entities.js';
import { Inventory, makeStack, HOTBAR_SIZE, maxStack, INV_SIZE, ARMOR_SIZE } from './inventory.js';
import { smeltRecipe } from './crafting.js';
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
const DAY_LENGTH = 600;
const SLEEP_SPEED = 80;
const SKY_DAY = 0x78a7ff;
const SKY_NIGHT = 0x05070f;
const SKY_DUSK = 0xd9803f;

class Game {
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
    this.buildSky();
    this.attackCd = 0;
    this.isDay = true;
    this.isNight = false;
    this.lightLevel = 1;
    this.baseFov = this.camera.fov;
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
    this.timeOfDay = 0.28;
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
    this.updateFog();

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
      this.dropOne();
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

  dropOne() {
    const s = this.inventory.held();
    if (!s) return;
    const n = this.inventory.removeAt(this.inventory.selected, 1);
    if (n > 0) this.spawnDrop(s.id, 1);
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
    this.updateFog();
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

  updateFog() {
    const d = this.world.renderDistance * CHUNK;
    this.scene.fog = new THREE.Fog(SKY_DAY, d * 0.55, d * 0.95);
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
        this.furnaces.set(k, { input: null, fuel: null, out: null, burn: 0, burnMax: 0, prog: 0, progMax: 1 });
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

    let cells;
    if (block.ore) {
      cells = this.collectOreVein(x, y, z, id, 48);
    } else {
      cells = [[x, y, z]];
    }

    for (const [bx, by, bz] of cells) {
      const b = BLOCKS[this.world.getBlock(bx, by, bz)] || block;
      this.mineBlock(bx, by, bz, b, harvest, toolDef);
    }

    if (held && toolDef) this.inventory.damageHeld(1);
    this.survival.addExhaustion(EXHAUST.mine);
    this.ui.render();
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

  mineBlock(x, y, z, block, harvest, toolDef) {
    this.world.setBlock(x, y, z, AIR);
    if (block.tiles) this.particles.burst(x, y, z, block.tiles[1] || block.tiles[0], 10);
    if (!block.unbreakable) this.sfx.breakBlock(block);
    if (harvest && block.drop !== null) {
      const dropKey = block.drop || block.key;
      const it = ITEM_BY_KEY[dropKey];
      if (it) {
        for (let i = 0; i < (block.dropCount || 1); i++) {
          this.dropped.spawn(it.id, 1, x + 0.5, y + 0.4, z + 0.5, null);
        }
      }
    }
    if (block.bonusDrop && Math.random() < block.bonusDrop.chance) {
      const bonus = ITEM_BY_KEY[block.bonusDrop.key];
      if (bonus) this.dropped.spawn(bonus.id, 1, x + 0.5, y + 0.4, z + 0.5, null);
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
    for (const f of this.furnaces.values()) {
      const rec = f.input ? smeltRecipe(f.input.id) : null;
      const canOutput = rec && (!f.out || (f.out.id === rec.output && f.out.count < maxStack(rec.output)));
      if (rec && canOutput) {
        if (f.burn <= 0 && f.fuel) {
          const fuelVal = ITEMS[f.fuel.id].fuel || 0;
          if (fuelVal > 0) {
            f.burn = fuelVal;
            f.burnMax = fuelVal;
            f.fuel.count--;
            if (f.fuel.count <= 0) f.fuel = null;
          }
        }
        if (f.burn > 0) {
          f.burn -= dt;
          f.progMax = rec.time;
          f.prog += dt;
          if (f.prog >= rec.time) {
            f.prog = 0;
            f.input.count--;
            if (f.input.count <= 0) f.input = null;
            if (f.out) f.out.count++;
            else f.out = makeStack(rec.output, 1);
            this.sfx.furnaceReady();
          }
        } else {
          f.prog = 0;
        }
      } else {
        f.prog = 0;
        if (f.burn > 0) f.burn = Math.max(0, f.burn - dt);
      }
      if (f.burn <= 0) f.burnMax = 0;
    }
    if (this.ui.isOpen() && this.ui.mode === 'furnace') this.ui.render();
  }

  buildSky() {
    const loader = new THREE.TextureLoader();
    const pixel = (t) => { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; return t; };

    const sunTex = pixel(loader.load('textures/environment/sun.png'));
    const moonTex = pixel(loader.load('textures/environment/moon_phases.png'));
    moonTex.repeat.set(0.25, 0.5);
    moonTex.offset.set(0, 0.5);

    const sprite = (tex, size) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, fog: false, depthWrite: false
      }));
      s.scale.set(size, size, 1);
      s.renderOrder = -2;
      this.scene.add(s);
      return s;
    };
    this.sun = sprite(sunTex, 64);
    this.moon = sprite(moonTex, 48);

    const cloudTex = loader.load('textures/environment/clouds.png');
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    cloudTex.repeat.set(20, 20);
    cloudTex.magFilter = THREE.NearestFilter;
    this.clouds = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 2600),
      new THREE.MeshBasicMaterial({
        map: cloudTex, transparent: true, opacity: 0.7,
        depthWrite: false, fog: false, side: THREE.DoubleSide
      })
    );
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = HEIGHT + 36;
    this.clouds.renderOrder = -1;
    this.scene.add(this.clouds);
  }

  updateDayNight(dt) {
    this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH) % 1;
    const t = this.timeOfDay;
    const elev = Math.sin(t * Math.PI * 2 - Math.PI / 2);
    this.isDay = elev > 0.15;
    this.isNight = elev < -0.1;
    const amt = Math.max(0.30, Math.min(1, elev * 1.6 + 0.45));
    const night = new THREE.Color(SKY_NIGHT);
    const day = new THREE.Color(SKY_DAY);
    const dusk = new THREE.Color(SKY_DUSK);
    let sky;
    if (elev > 0.15) sky = day;
    else if (elev > -0.15) sky = dusk.clone().lerp(day, (elev + 0.15) / 0.3);
    else sky = night.clone().lerp(dusk, Math.max(0, (elev + 0.5) / 0.35));
    this.scene.background = sky;
    if (this.scene.fog) this.scene.fog.color.copy(sky);
    const light = 0.30 + 0.70 * amt;
    this.lightLevel = light;
    this.world.matOpaque.color.setRGB(light, light, light * (0.96 + 0.04 * amt));
    this.world.matWater.color.setRGB(light, light, light);
    this.world.matGlass.color.setRGB(light, light, light);
    const a = this.timeOfDay * Math.PI * 2 - Math.PI / 2;
    const sx = Math.cos(a) * 420, sy = Math.sin(a) * 420;
    const cp = this.camera.position;
    this.sun.position.set(cp.x + sx, cp.y + sy, cp.z - 220);
    this.moon.position.set(cp.x - sx, cp.y - sy, cp.z - 220);
    this.sun.visible = sy > -40;
    this.moon.visible = sy < 40;
    this.clouds.position.x = cp.x;
    this.clouds.position.z = cp.z;
    const off = this.clouds.material.map.offset;
    off.x = (off.x + dt * 0.0035) % 1;
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
      this.dropped.update(dt, this.player.pos, this.inventory, (id, n) => {
        this.sfx.pickup();
        this.ui.showHint('+' + n + ' ' + ITEMS[id].label);
        this.ui.render();
      });
      this.updateFurnaces(dt);
      this.particles.update(dt);
      this.ui.tick(dt);
      this.autoTuneQuality(dt);
      this.updateFov(dt);
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

    this.updateHud();
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

  updateFov(dt) {
    const target = this.baseFov + (this.player.sprinting ? 8 : 0);
    const diff = target - this.camera.fov;
    if (Math.abs(diff) < 0.05) return;
    this.camera.fov += diff * Math.min(1, dt * 8);
    this.camera.updateProjectionMatrix();
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

  updateHud() {
    const p = this.player;
    const st = armorStats(this.inventory.armor);
    this.survival.setArmor(st.points, st.toughness);
    this.hud.update(this.survival);
    this.updateHand();
    const held = this.inventory.held();
    const bio = biomeAt(Math.floor(p.pos.x), Math.floor(p.pos.z));
    const bioName = { plains: '平原', forest: '森林', desert: '沙漠', snowy: '雪原', mountains: '山地' }[bio] || bio;
    this.debugEl.textContent = this.fps + ' FPS · 区块 ' + this.world.chunks.size +
      ' · 待更新 ' + this.world.dirty.size + ' · 渲染距离 ' + this.world.renderDistance +
      ' · 生物 ' + this.mobs.count() + (this.isNight ? ' · 夜晚' : ' · 白天');
    this.coordEl.textContent = 'XYZ ' + p.pos.x.toFixed(1) + ' / ' + p.pos.y.toFixed(1) + ' / ' + p.pos.z.toFixed(1) +
      ' · ' + bioName + ' · ' + (held ? ITEMS[held.id].label : '空手') +
      (this.player.flying ? ' · 飞行' : '');
  }

  updateHand() {
    const el = this.handEl;
    if (!el) return;
    const held = this.inventory.held();
    if (!held) {
      if (this.lastHandId !== -1) { el.style.display = 'none'; this.lastHandId = -1; }
      return;
    }
    if (el.style.display === 'none') el.style.display = 'block';
    if (this.lastHandId !== held.id) {
      const ctx = el.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, 72, 72);
      ctx.drawImage(itemIconCanvas(this.atlasCanvas, ITEMS[held.id], 72), 0, 0, 72, 72);
      this.lastHandId = held.id;
    }
    const amp = this.player.flying ? 0 : this.player.bobAmount;
    const bobY = Math.sin(this.player.bobPhase * 2) * 7 * amp;
    const bobX = Math.cos(this.player.bobPhase) * 5 * amp;
    const swing = this.mining ? Math.sin(performance.now() / 80) * 16 : 0;
    el.style.transform = 'translate(' + bobX.toFixed(2) + 'px,' + bobY.toFixed(2) + 'px) rotate(' + swing.toFixed(1) + 'deg)';
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
