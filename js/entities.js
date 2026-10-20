import * as THREE from './vendor/three.module.js';
import { ITEMS, itemIconCanvas } from './items.js';
import { isSolid } from './blocks.js';
import { boxHitsBlock, blockTop } from './shapes.js';
import { HEIGHT } from './worlddef.js';

const GRAVITY = 24;
const PICKUP_DELAY = 0.4;
const PICKUP_RANGE = 1.7;
const DROP_SIZE = 0.36;
// 原版掉落物 6000 tick = 5 分钟后消失。之前只有摔出世界（y < -20）才删，
// 扔在地上的东西会永远留着。
const DESPAWN_AGE = 300;

export class DroppedItems {
  constructor(scene, world, atlasCanvas) {
    this.scene = scene;
    this.world = world;
    this.atlasCanvas = atlasCanvas;
    this.list = [];
    this.texCache = new Map();
    this.geo = new THREE.PlaneGeometry(0.32, 0.32);
  }

  textureFor(id) {
    let t = this.texCache.get(id);
    if (t) return t;
    const c = itemIconCanvas(this.atlasCanvas, ITEMS[id], 32);
    t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    // 掉在地上的物品也是画布贴图，同样要声明成 sRGB，不然会比背包里的图标白一档。
    t.colorSpace = THREE.SRGBColorSpace;
    this.texCache.set(id, t);
    return t;
  }

  spawn(id, count, x, y, z, vel, dmg) {
    const mat = new THREE.SpriteMaterial({ map: this.textureFor(id), transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.01, 0.01, 1);
    sprite.position.set(x, y, z);
    sprite.renderOrder = 3;
    this.scene.add(sprite);
    this.list.push({
      id, count, dmg: dmg || 0,
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(vel ? vel.x : (Math.random() - 0.5) * 1.6,
        vel ? vel.y : 3.2,
        vel ? vel.z : (Math.random() - 0.5) * 1.6),
      age: 0,
      born: 0,
      spin: Math.random() * Math.PI * 2,
      sprite
    });
  }

  update(dt, player, inventory, onPickup) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      e.age += dt;

      const p = e.pos;
      const feetY = p.y;
      // 脚底往下 0.12 探一格，看踩在什么上面。要注意这一格的**顶面不一定在 y+1**：
      // 床只有 9/16 高，写死 +1.12 会让掉在床上的物品浮起 7/16。
      const bx = Math.floor(p.x), by = Math.floor(feetY - 0.12), bz = Math.floor(p.z);
      const belowId = by >= 0 && by < HEIGHT ? this.world.getBlock(bx, by, bz) : 0;
      const belowSolid = isSolid(belowId);

      e.vel.y -= GRAVITY * dt;
      if (belowSolid && e.vel.y < 0) {
        if (e.vel.y < -4) e.vel.y = -e.vel.y * 0.35;
        else e.vel.y = 0;
        e.vel.x *= Math.pow(0.001, dt);
        e.vel.z *= Math.pow(0.001, dt);
        p.y = by + blockTop(belowId, this.world.getMeta(bx, by, bz)) + 0.12;
      }

      this.moveAxis(e, 'x', e.vel.x * dt);
      this.moveAxis(e, 'y', e.vel.y * dt);
      this.moveAxis(e, 'z', e.vel.z * dt);

      e.born += dt;
      const grow = Math.min(1, e.born / 0.15);
      e.sprite.scale.set(DROP_SIZE * grow, DROP_SIZE * grow, 1);
      e.sprite.position.set(p.x, p.y + Math.sin(e.age * 2.4) * 0.045, p.z);
      e.sprite.material.rotation = Math.sin(e.age * 1.6 + e.spin) * 0.18;

      if (e.age > PICKUP_DELAY) {
        const dx = player.x - p.x;
        const dy = (player.y + 0.9) - p.y;
        const dz = player.z - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < PICKUP_RANGE * PICKUP_RANGE) {
          const d = Math.sqrt(d2) || 1;
          const pull = 7.5 * dt;
          p.x += (dx / d) * pull * 2;
          p.y += (dy / d) * pull * 2;
          p.z += (dz / d) * pull * 2;
          e.sprite.position.set(p.x, p.y, p.z);
          if (d < 0.7) {
            const left = inventory.add(e.id, e.count, e.dmg);
            if (left < e.count) {
              const taken = e.count - left;
              if (onPickup) onPickup(e.id, taken);
              if (left > 0) { e.count = left; continue; }
              this.remove(i);
              continue;
            }
          }
        }
      }
      if (e.age >= DESPAWN_AGE || p.y < -20) this.remove(i);
    }
  }

  moveAxis(e, axis, amount) {
    if (amount === 0) return;
    const old = e.pos[axis];
    e.pos[axis] += amount;
    if (this.hitsSolid(e.pos)) e.pos[axis] = old;
  }

  hitsSolid(p) {
    const r = 0.16;
    const box = { minX: p.x - r, maxX: p.x + r, minY: p.y, maxY: p.y + 0.3, minZ: p.z - r, maxZ: p.z + r };
    const x0 = Math.floor(box.minX), x1 = Math.floor(box.maxX - 1e-6);
    const z0 = Math.floor(box.minZ), z1 = Math.floor(box.maxZ - 1e-6);
    const y0 = Math.floor(box.minY), y1 = Math.floor(box.maxY - 1e-6);
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= HEIGHT) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = this.world.getBlock(x, y, z);
          if (!isSolid(id)) continue;
          // 掉落物的移动也按判定箱比：床只有 9/16 高，从旁边滚过去应该蹭着床垫走，
          // 而不是被整格挡住、也不是穿过去。
          if (boxHitsBlock(box, x, y, z, id, this.world.getMeta(x, y, z))) return true;
        }
      }
    }
    return false;
  }

  remove(i) {
    const e = this.list[i];
    this.scene.remove(e.sprite);
    e.sprite.material.dispose();
    this.list.splice(i, 1);
  }

  clear() {
    while (this.list.length) this.remove(0);
  }
}
