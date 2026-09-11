import * as THREE from './vendor/three.module.js';
import { ITEMS, itemIconCanvas } from './items.js';
import { isSolid } from './blocks.js';
import { HEIGHT } from './world.js';

const GRAVITY = 24;
const PICKUP_DELAY = 0.4;
const PICKUP_RANGE = 1.7;
const DROP_SIZE = 0.36;

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
    this.texCache.set(id, t);
    return t;
  }

  spawn(id, count, x, y, z, vel) {
    const mat = new THREE.SpriteMaterial({ map: this.textureFor(id), transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.01, 0.01, 1);
    sprite.position.set(x, y, z);
    sprite.renderOrder = 3;
    this.scene.add(sprite);
    this.list.push({
      id, count,
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
      const belowSolid = this.isSolidAt(Math.floor(p.x), Math.floor(feetY - 0.12), Math.floor(p.z));

      e.vel.y -= GRAVITY * dt;
      if (belowSolid && e.vel.y < 0) {
        if (e.vel.y < -4) e.vel.y = -e.vel.y * 0.35;
        else e.vel.y = 0;
        e.vel.x *= Math.pow(0.001, dt);
        e.vel.z *= Math.pow(0.001, dt);
        p.y = Math.floor(feetY - 0.12) + 1.12;
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
            const left = inventory.add(e.id, e.count);
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
      if (p.y < -20) this.remove(i);
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
    const x0 = Math.floor(p.x - r), x1 = Math.floor(p.x + r);
    const z0 = Math.floor(p.z - r), z1 = Math.floor(p.z + r);
    const y0 = Math.floor(p.y), y1 = Math.floor(p.y + 0.3);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (this.isSolidAt(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  isSolidAt(x, y, z) {
    if (y < 0 || y >= HEIGHT) return false;
    const id = this.world.getBlock(x, y, z);
    return isSolid(id);
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
