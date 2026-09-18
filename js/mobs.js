import * as THREE from './vendor/three.module.js';
import { isSolid, isLiquid } from './blocks.js';
import { HEIGHT } from './worlddef.js';
import { terrainHeight } from './worldgen.js';
import { mobArt } from './mobtex.js';

const GRAVITY = 24;
const DESPAWN_DIST = 72;
const MAX_PASSIVE = 12;
const MAX_HOSTILE = 10;
const PANIC_DURATION = 8;

export const MOB_TYPES = {
  pig: { label: '猪', hostile: false, health: 10, speed: 1.5,  w: 0.9, h: 0.9, drops: [{ key: 'porkchop', min: 1, max: 3 }] },
  cow: { label: '牛', hostile: false, health: 10, speed: 1.4,  w: 0.9, h: 1.3, drops: [{ key: 'beef', min: 1, max: 3 }, { key: 'leather', min: 0, max: 2 }] },
  chicken: { label: '鸡', hostile: false, health: 4, speed: 1.5,  w: 0.5, h: 0.7, drops: [{ key: 'chicken', min: 1, max: 1 }, { key: 'feather', min: 0, max: 2 }] },
  sheep: { label: '羊', hostile: false, health: 8, speed: 1.4,  w: 0.9, h: 1.2, drops: [{ key: 'mutton', min: 1, max: 2 }, { key: 'wool', min: 1, max: 1 }] },
  zombie: { label: '僵尸', hostile: true, health: 20, speed: 1.7, damage: 3, reach: 1.7,  w: 0.7, h: 1.9, drops: [{ key: 'rotten_flesh', min: 0, max: 2 }], burns: true },
  skeleton: { label: '骷髅', hostile: true, health: 20, speed: 1.8, damage: 2, reach: 14, ranged: true,  w: 0.65, h: 1.9, drops: [{ key: 'bone', min: 0, max: 2 }, { key: 'arrow', min: 0, max: 2 }], burns: true },
  creeper: { label: '苦力怕', hostile: true, health: 20, speed: 1.8, damage: 0, reach: 3, explode: true,  w: 0.7, h: 1.7, drops: [{ key: 'gunpowder', min: 0, max: 2 }] }
};

const PASSIVE = ['pig', 'cow', 'chicken', 'sheep'];
const HOSTILE = ['zombie', 'skeleton', 'creeper'];

const geoCache = new Map();
const ARROW_GEO = new THREE.BoxGeometry(0.06, 0.06, 0.5);
const ARROW_MAT = new THREE.MeshBasicMaterial({ color: 0x6b4a2a });

function buildMesh(type) {
  const art = mobArt[type];
  const def = MOB_TYPES[type];
  const h = def.h;
  const w = Math.min(def.w, h * art.ratio);
  let g = geoCache.get(type);
  if (!g) {
    g = new THREE.PlaneGeometry(w, h);
    g.translate(0, h / 2, 0);
    geoCache.set(type, g);
  }
  const mat = new THREE.MeshBasicMaterial({
    map: art.tex,
    transparent: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide
  });
  return new THREE.Mesh(g, mat);
}

class Mob {
  constructor(type, x, y, z) {
    this.type = type;
    this.def = MOB_TYPES[type];
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.health = this.def.health;
    this.onGround = false;
    this.inWater = false;
    this.dead = false;
    this.dieT = -1;
    this.dieRoll = (Math.random() - 0.5) * 0.5;
    this.age = 0;
    this.wanderTimer = 0;
    this.pauseTimer = 0;
    this.waterT = 0;
    this.attackCd = 0;
    this.fuse = -1;
    this.panic = 0;
    this.hurtFlash = 0;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.walkAmp = 0;
    this.idlePhase = Math.random() * Math.PI * 2;
    this.lungeT = 0;
    this.ambientT = 4 + Math.random() * 8;
    this.stuckT = 0;
    this.lastTarget = { x: 0, z: 0 };
    this.sfx = null;
    this.mesh = buildMesh(type);
    this.mesh.position.copy(this.pos);
  }

  hurt(amount, knockDir) {
    this.health -= amount;
    this.hurtFlash = 0.4;
    if (knockDir) {
      this.vel.x += knockDir.x * 9;
      this.vel.z += knockDir.z * 9;
      this.vel.y = 5;
    }
    if (!this.def.hostile) this.panic = PANIC_DURATION;
    if (this.health <= 0 && this.dieT < 0) {
      this.dead = true;
      this.dieT = 0;
      this.dieRoll = (Math.random() - 0.5) * 1.0;
    }
    if (this.sfx) this.sfx.mobHurt(this.type);
  }

  halfWidth() { return this.def.w / 2; }
}

export class MobManager {
  constructor(scene, world, camera) {
    this.scene = scene;
    this.world = world;
    this.camera = camera;
    this.list = [];
    this.arrows = [];
    this.spawnTimer = 0;
    this.sfx = null;
  }

  count() { return this.list.length; }
  countHostile() { return this.list.filter((m) => m.def.hostile).length; }
  countPassive() { return this.list.filter((m) => !m.def.hostile).length; }

  spawn(type, x, y, z) {
    const m = new Mob(type, x, y, z);
    m.sfx = this.sfx;
    this.scene.add(m.mesh);
    this.list.push(m);
    return m;
  }

  remove(i) {
    const m = this.list[i];
    this.scene.remove(m.mesh);
    m.mesh.material.dispose();
    this.list.splice(i, 1);
  }

  clear() {
    while (this.list.length) this.remove(0);
    for (const a of this.arrows) this.scene.remove(a.mesh);
    this.arrows.length = 0;
  }

  isLiquidAt(x, y, z) {
    return isLiquid(this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  isSolidAt(x, y, z) {
    if (y < 0 || y >= HEIGHT) return false;
    return isSolid(this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  hitsSolid(m, x, y, z) {
    const r = m.halfWidth();
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
    const z0 = Math.floor(z - r), z1 = Math.floor(z + r);
    const y0 = Math.floor(y), y1 = Math.floor(y + m.def.h - 0.01);
    for (let yy = y0; yy <= y1; yy++) {
      for (let zz = z0; zz <= z1; zz++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (this.isSolidAt(xx, yy, zz)) return true;
        }
      }
    }
    return false;
  }

  moveAxis(m, axis, amount) {
    if (amount === 0) return true;
    const old = m.pos[axis];
    m.pos[axis] += amount;
    if (this.hitsSolid(m, m.pos.x, m.pos.y, m.pos.z)) {
      m.pos[axis] = old;
      if (axis === 'y') {
        if (amount < 0) m.onGround = true;
        m.vel.y = 0;
      }
      return false;
    }
    return true;
  }

  pickYawToward(m, targetX, targetZ, spread) {
    const base = Math.atan2(targetX - m.pos.x, targetZ - m.pos.z);
    const candidates = spread >= 0
      ? [0, spread, -spread, spread * 2, -spread * 2]
      : [0];
    let best = base, bestScore = -Infinity;
    for (const off of candidates) {
      const a = base + off;
      const nx = m.pos.x + Math.sin(a) * 0.5;
      const nz = m.pos.z + Math.cos(a) * 0.5;
      if (this.hitsSolid(m, nx, m.pos.y, nz)) continue;
      const ahead = m.pos.y + m.def.h;
      if (this.isSolidAt(nx, ahead, nz) && this.isSolidAt(nx, ahead + 1, nz)) continue;
      const score = -Math.abs(off);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  update(dt, player, ctx) {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 3;
      this.trySpawn(player, ctx.isNight);
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const m = this.list[i];
      m.age += dt;
      if (m.hurtFlash > 0) m.hurtFlash -= dt;
      if (m.lungeT > 0) m.lungeT -= dt;

      if (m.dieT >= 0) {
        this.updateDying(m, dt, i, ctx);
        continue;
      }

      const dx = player.pos.x - m.pos.x;
      const dz = player.pos.z - m.pos.z;
      const dist = Math.hypot(dx, dz);

      if (dist > DESPAWN_DIST || m.pos.y < -20) { this.remove(i); continue; }

      if (m.ambientT > 0) m.ambientT -= dt;
      if (m.ambientT <= 0) {
        m.ambientT = 7 + Math.random() * 9;
        if (m.sfx && dist < 18) m.sfx.mobIdle(m.type);
      }

      this.think(m, dt, dx, dz, dist, player, ctx);
      this.physics(m, dt);

      if (ctx.isDay && m.def.burns && this.exposedToSky(m)) {
        m.health -= dt * 4;
        if (m.health <= 0 && m.dieT < 0) {
          m.dead = true;
          m.dieT = 0;
          m.dieRoll = (Math.random() - 0.5) * 1.0;
        }
        if (m.dieT >= 0) { this.updateDying(m, dt, i, ctx); continue; }
      }

      const hs = Math.hypot(m.vel.x, m.vel.z);
      const targetAmp = m.onGround && !m.inWater && hs > 0.4
        ? Math.min(0.06, hs * 0.05) : 0;
      m.walkAmp += (targetAmp - m.walkAmp) * Math.min(1, dt * 10);
      m.walkPhase += dt * hs * 4.5;

      const bob = Math.sin(m.walkPhase * 2) * m.walkAmp;
      const sway = Math.cos(m.walkPhase * 2) * m.walkAmp;
      const tiltX = m.def.hostile ? sway * 0.5 : 0;
      const tiltZ = m.def.hostile ? 0 : sway * 1.2;

      let yOff = bob;
      if (!(m.onGround && !m.inWater && hs > 0.4)) {
        yOff += Math.sin(m.age * 2.5 + m.idlePhase) * 0.03;
      }
      let shakeX = 0, shakeZ = 0, shakeRot = 0;
      if (m.hurtFlash > 0) {
        const a = (m.hurtFlash / 0.4) * 0.11;
        shakeX = Math.sin(m.age * 55) * a;
        shakeZ = Math.cos(m.age * 47) * a;
        shakeRot = Math.sin(m.age * 65) * a * 0.14;
      }
      m.mesh.position.set(m.pos.x + shakeX, m.pos.y + yOff, m.pos.z + shakeZ);
      m.mesh.rotation.set(
        tiltX + shakeRot,
        Math.atan2(this.camera.position.x - m.pos.x, this.camera.position.z - m.pos.z),
        tiltZ + shakeRot
      );

      let sx = 1, sy = 1, sz = 1;
      if (m.fuse >= 0 && m.fuse < 1.5) {
        const k = 1 - (m.fuse / 1.5);
        const s = 1 + k * 0.28;
        sx = sy = sz = s;
      }
      if (m.lungeT > 0) {
        const l = m.lungeT / 0.3;
        sx += 0.2 * l; sy += 0.2 * l; sz += 0.2 * l;
      }
      if (m.hurtFlash > 0) {
        const f = m.hurtFlash / 0.4;
        sx += 0.14 * f; sy -= 0.12 * f; sz += 0.14 * f;
      }
      m.mesh.scale.set(sx, sy, sz);

      const l = ctx.light === undefined ? 1 : ctx.light;
      let flashBoost = m.hurtFlash > 0 ? l * 0.35 : 0;
      if (m.fuse >= 0 && m.fuse < 1.5) {
        const k = 1 - (m.fuse / 1.5);
        if (k > 0.6) flashBoost += (k - 0.6) * 2.6;
      }
      m.mesh.material.color.setRGB(l, Math.max(0, l - flashBoost), Math.max(0, l - flashBoost));
    }

    this.updateArrows(dt, player, ctx);
  }

  updateDying(m, dt, i, ctx) {
    if (m.dieT === 0 && m.sfx) m.sfx.mobDeath(m.type);
    m.dieT += dt / 0.9;
    const k = Math.min(1, m.dieT);
    m.vel.x *= 0.88;
    m.vel.z *= 0.88;
    if (m.onGround) {
      m.vel.y = 0;
    } else {
      m.vel.y -= GRAVITY * dt * 0.4;
      if (m.vel.y < -8) m.vel.y = -8;
    }
    this.moveAxis(m, 'y', m.vel.y * dt);
    this.moveAxis(m, 'x', m.vel.x * dt);
    this.moveAxis(m, 'z', m.vel.z * dt);
    m.mesh.position.set(m.pos.x, m.pos.y, m.pos.z);
    m.mesh.rotation.set(0, m.mesh.rotation.y, -k * Math.PI / 2 + m.dieRoll * k);
    m.mesh.material.opacity = 1 - k * 0.85;
    m.mesh.scale.set(1, 1, 1);
    if (k >= 1) {
      this.kill(m, i, ctx);
    }
  }

  exposedToSky(m) {
    const x = Math.floor(m.pos.x), z = Math.floor(m.pos.z);
    const y = Math.floor(m.pos.y + m.def.h) + 1;
    for (let yy = y; yy < HEIGHT; yy++) {
      if (this.isSolidAt(x, yy, z)) return false;
    }
    return true;
  }

  think(m, dt, dx, dz, dist, player, ctx) {
    const d = m.def;
    if (m.attackCd > 0) m.attackCd -= dt;
    if (m.panic > 0) m.panic -= dt;

    if (d.hostile && dist < 20) {
      const want = Math.atan2(dx, dz);
      m.yaw = this.pickYawToward(m, player.pos.x, player.pos.z, Math.PI / 3);
      const fwdX = Math.sin(m.yaw), fwdZ = Math.cos(m.yaw);
      let mx = fwdX, mz = fwdZ;

      if (d.explode) {
        if (dist < d.reach) {
          if (m.fuse < 0) { m.fuse = 1.5; if (m.sfx) m.sfx.creeperHiss(); }
          m.fuse -= dt;
          mx *= 0.3; mz *= 0.3;
          if (m.fuse <= 0) { this.explode(m, player, ctx); return; }
        } else {
          m.fuse = -1;
        }
      } else if (d.ranged) {
        if (dist < 4) { mx *= -0.7; mz *= -0.7; }
        else if (dist < d.reach) {
          mx = 0; mz = 0;
          if (m.attackCd <= 0) {
            m.attackCd = 2;
            this.shoot(m, player);
          }
        }
      } else if (dist < d.reach) {
        mx = 0; mz = 0;
        if (m.attackCd <= 0) {
          m.attackCd = 1;
          m.lungeT = 0.3;
          if (m.sfx) m.sfx.mobAttack(m.type);
          ctx.onPlayerHit(d.damage, d.label);
        }
      }

      m.vel.x = mx * d.speed;
      m.vel.z = mz * d.speed;
      m.lastTarget.x = player.pos.x;
      m.lastTarget.z = player.pos.z;
      return;
    }

    if (m.panic > 0 && dist < 16) {
      const inv = dist > 0.001 ? 1 / dist : 0;
      m.yaw = Math.atan2(-dx * inv, -dz * inv);
      m.vel.x = -dx * inv * d.speed * 1.7;
      m.vel.z = -dz * inv * d.speed * 1.7;
      return;
    }

    if (m.pauseTimer > 0) {
      m.pauseTimer -= dt;
      m.vel.x = 0;
      m.vel.z = 0;
      return;
    }
    m.wanderTimer -= dt;
    if (m.wanderTimer <= 0) {
      m.wanderTimer = 1 + Math.random() * 2.5;
      m.yaw = Math.random() * Math.PI * 2;
      if (Math.random() < 0.35) m.pauseTimer = 1 + Math.random() * 2;
    }
    m.vel.x = Math.sin(m.yaw) * d.speed * 0.55;
    m.vel.z = Math.cos(m.yaw) * d.speed * 0.55;
  }

  physics(m, dt) {
    m.vel.y -= GRAVITY * dt;
    if (m.vel.y < -40) m.vel.y = -40;
    m.onGround = false;
    m.inWater = this.isLiquidAt(m.pos.x, m.pos.y + 0.3, m.pos.z);

    if (m.inWater) {
      m.vel.y += 14 * dt;
      if (m.vel.y > 2) m.vel.y = 2;
      m.vel.x *= 0.82;
      m.vel.z *= 0.82;
      m.waterT += dt;
      if (m.waterT > 1.5) {
        m.yaw += Math.PI * (0.4 + Math.random() * 0.6);
        m.waterT = 0;
      }
    } else {
      m.waterT = 0;
    }

    this.moveAxis(m, 'y', m.vel.y * dt);

    const horiz = Math.hypot(m.vel.x, m.vel.z);
    const movedX = this.moveAxis(m, 'x', m.vel.x * dt);
    const movedZ = this.moveAxis(m, 'z', m.vel.z * dt);
    if (horiz > 0.2 && (!movedX || !movedZ)) {
      m.stuckT += dt;
      if (m.stuckT > 0.35) {
        m.yaw += Math.PI * (0.5 + Math.random() * 0.7);
        m.stuckT = 0;
      }
    } else {
      m.stuckT = Math.max(0, m.stuckT - dt * 2);
    }

    if (m.onGround) {
      m.vel.x *= 0.85;
      m.vel.z *= 0.85;
    }
    if (this.isSolidAt(m.pos.x, m.pos.y + 0.4, m.pos.z) && m.onGround) {
      m.vel.y = 8;
    }
  }

  shoot(m, player) {
    if (this.sfx) this.sfx.shoot();
    const mesh = new THREE.Mesh(ARROW_GEO, ARROW_MAT);
    const from = new THREE.Vector3(m.pos.x, m.pos.y + m.def.h * 0.7, m.pos.z);
    mesh.position.copy(from);
    this.scene.add(mesh);
    const dir = new THREE.Vector3(
      player.pos.x - from.x,
      player.pos.y + 0.9 - from.y,
      player.pos.z - from.z
    ).normalize();
    this.arrows.push({ mesh, dir, life: 3 });
    mesh.lookAt(from.clone().add(dir));
  }

  updateArrows(dt, player, ctx) {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.life -= dt;
      a.mesh.position.addScaledVector(a.dir, 18 * dt);
      const dx = a.mesh.position.x - player.pos.x;
      const dy = a.mesh.position.y - (player.pos.y + 0.9);
      const dz = a.mesh.position.z - player.pos.z;
      if (dx * dx + dy * dy + dz * dz < 0.6) {
        ctx.onPlayerHit(2, '骷髅');
        this.scene.remove(a.mesh);
        this.arrows.splice(i, 1);
        continue;
      }
      if (a.life <= 0 || this.isSolidAt(a.mesh.position.x, a.mesh.position.y, a.mesh.position.z)) {
        this.scene.remove(a.mesh);
        this.arrows.splice(i, 1);
      }
    }
  }

  explode(m, player, ctx) {
    if (this.sfx) this.sfx.explode();
    const dx = player.pos.x - m.pos.x;
    const dy = (player.pos.y + 0.9) - (m.pos.y + m.def.h * 0.5);
    const dz = player.pos.z - m.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 5) ctx.onPlayerHit(Math.round((1 - dist / 5) * 12), '苦力怕');
    m.dead = true;
    m.dieT = 0;
  }

  kill(m, i, ctx) {
    if (ctx && ctx.spawnDrop) {
      for (const drop of m.def.drops) {
        const n = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
        for (let k = 0; k < n; k++) {
          ctx.spawnDrop(
            drop.key,
            m.pos.x + (Math.random() - 0.5) * 0.7,
            m.pos.y + 0.5 + Math.random() * 0.4,
            m.pos.z + (Math.random() - 0.5) * 0.7
          );
        }
      }
    }
    this.remove(i);
  }

  trySpawn(player, isNight) {
    const passive = this.countPassive();
    const hostile = this.countHostile();
    const wantHostile = isNight && hostile < MAX_HOSTILE;
    const wantPassive = !isNight && passive < MAX_PASSIVE;
    if (!wantHostile && !wantPassive) return;

    for (let attempt = 0; attempt < 8; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 22 + Math.random() * 26;
      const x = Math.floor(player.pos.x + Math.cos(ang) * r);
      const z = Math.floor(player.pos.z + Math.sin(ang) * r);
      let y = terrainHeight(x, z) + 1;
      if (y <= 1 || y >= HEIGHT - 3) continue;
      // scan up a few blocks to find a clear cell under cover/short blocks
      while (y < HEIGHT - 3 && this.isSolidAt(x + 0.5, y, z + 0.5)) y++;
      if (y >= HEIGHT - 3) continue;
      if (this.isSolidAt(x + 0.5, y + 1, z + 0.5)) continue;
      const ground = this.world.getBlock(x, y - 1, z);
      if (!isSolid(ground)) continue;
      if (isLiquid(ground)) continue;

      const lt = this.world.lightAt(x, y, z);
      if (wantHostile) {
        if (lt.lit > 7) continue;
      } else {
        if (lt.sky < 8) continue;
      }

      // avoid stacking on top of another mob
      let tooClose = false;
      for (const m of this.list) {
        if (Math.abs(m.pos.x - (x + 0.5)) < 2.0 && Math.abs(m.pos.z - (z + 0.5)) < 2.0) {
          tooClose = true; break;
        }
      }
      if (tooClose) continue;

      const pool = wantHostile ? HOSTILE : PASSIVE;
      const type = pool[(Math.random() * pool.length) | 0];
      this.spawn(type, x + 0.5, y, z + 0.5);
      return;
    }
  }

  raycast(eye, dir, maxDist) {
    let best = null;
    let bestT = maxDist;
    for (const m of this.list) {
      const dx = m.pos.x - eye.x;
      const dy = m.pos.y + m.def.h * 0.5 - eye.y;
      const dz = m.pos.z - eye.z;
      const t = dx * dir.x + dy * dir.y + dz * dir.z;
      if (t < 0 || t > bestT) continue;
      const px = dx - dir.x * t, py = dy - dir.y * t, pz = dz - dir.z * t;
      const r = m.halfWidth() + 0.35;
      if (Math.hypot(px, py, pz) > r + m.def.h * 0.5) continue;
      best = m;
      bestT = t;
    }
    return best;
  }
}