import * as THREE from './vendor/three.module.js';
import { isSolid, isLiquid } from './blocks.js';
import { HEIGHT } from './world.js';

export const P_WIDTH = 0.6;
export const P_HEIGHT = 1.8;
export const P_EYE = 1.62;

const GRAVITY = 28;
const JUMP_VEL = 8.4;
const WALK = 4.317;
const SPRINT = 5.612;
const SNEAK = 1.295;
const SWIM = 2.6;

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = new THREE.Vector3(0.5, 80, 0.5);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.inWater = false;
    this.flying = false;
    this.sprinting = false;
    this.sneaking = false;
    this.canSprint = true;
    this.fallDistance = 0;
    this.lastGroundY = this.pos.y;
    this.headInWater = false;
    this.movedDistance = 0;
    this.jumped = false;
    this.justLanded = false;
    this.landedFall = 0;
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.eyeH = P_EYE;
    this.landDip = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
  }

  eyePos(out) {
    return (out || new THREE.Vector3()).set(this.pos.x, this.pos.y + this.eyeH - this.landDip, this.pos.z);
  }

  box() {
    const h = P_WIDTH / 2;
    return {
      minX: this.pos.x - h, maxX: this.pos.x + h,
      minY: this.pos.y, maxY: this.pos.y + P_HEIGHT,
      minZ: this.pos.z - h, maxZ: this.pos.z + h
    };
  }

  collides(box) {
    const b = box || this.box();
    const x0 = Math.floor(b.minX), x1 = Math.floor(b.maxX - 1e-6);
    const y0 = Math.floor(b.minY), y1 = Math.floor(b.maxY - 1e-6);
    const z0 = Math.floor(b.minZ), z1 = Math.floor(b.maxZ - 1e-6);
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= HEIGHT) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (isSolid(this.world.getBlock(x, y, z))) return true;
        }
      }
    }
    return false;
  }

  checkWater() {
    const b = this.box();
    const x0 = Math.floor(b.minX), x1 = Math.floor(b.maxX - 1e-6);
    const y0 = Math.floor(b.minY), y1 = Math.floor(b.minY + 0.4);
    const z0 = Math.floor(b.minZ), z1 = Math.floor(b.maxZ - 1e-6);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = this.world.getBlock(x, y, z);
          if (isLiquid(id)) return true;
        }
      }
    }
    return false;
  }

  checkHeadWater() {
    const e = this.eyePos();
    return isLiquid(this.world.getBlock(Math.floor(e.x), Math.floor(e.y), Math.floor(e.z)));
  }

  update(dt, input) {
    this.updateLook(dt);
    this.inWater = this.checkWater();
    this.headInWater = this.checkHeadWater();
    this.sneaking = !!input.sneak && !this.flying;
    this.sprinting = !!input.sprint && !!input.forward && !this.sneaking && !this.inWater && this.canSprint;
    this.jumped = false;
    this.justLanded = false;
    this.landedFall = 0;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const fx = -sin, fz = -cos;
    const rx = cos, rz = -sin;

    let mx = 0, mz = 0;
    if (input.forward) { mx += fx; mz += fz; }
    if (input.back) { mx -= fx; mz -= fz; }
    if (input.right) { mx += rx; mz += rz; }
    if (input.left) { mx -= rx; mz -= rz; }
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }

    let speed = this.sneaking ? SNEAK : (this.sprinting ? SPRINT : WALK);
    if (this.inWater && !this.flying) speed = SWIM;

    if (this.flying) {
      const fbx = this.pos.x, fbz = this.pos.z;
      speed = this.sprinting ? 12 : 6;
      this.vel.set(mx * speed, 0, mz * speed);
      if (input.jump) this.vel.y = speed;
      else if (input.sneak) this.vel.y = -speed;
      this.moveAxis('x', this.vel.x * dt);
      this.moveAxis('y', this.vel.y * dt);
      this.moveAxis('z', this.vel.z * dt);
      this.onGround = false;
      this.movedDistance = Math.hypot(this.pos.x - fbx, this.pos.z - fbz);
      this.fallDistance = 0;
      this.lastGroundY = this.pos.y;
      return;
    }

    const accel = this.inWater ? 8 : (!this.onGround ? 6 : ((mx || mz) ? 25 : 35));
    const ak = 1 - Math.exp(-accel * dt);
    this.vel.x += (mx * speed - this.vel.x) * ak;
    this.vel.z += (mz * speed - this.vel.z) * ak;

    if (this.inWater) {
      this.vel.y -= 8 * dt;
      if (this.vel.y < -2.2) this.vel.y = -2.2;
      if (input.jump) this.vel.y = 3.4;
    } else {
      this.vel.y -= GRAVITY * dt;
      if (input.jump && this.onGround) {
        this.vel.y = JUMP_VEL;
        this.onGround = false;
        this.jumped = true;
      }
    }
    if (this.vel.y < -55) this.vel.y = -55;

    const wasGround = this.onGround;
    const bx = this.pos.x, bz = this.pos.z;
    this.onGround = false;
    this.moveAxis('y', this.vel.y * dt, true);
    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('z', this.vel.z * dt);
    this.movedDistance = Math.hypot(this.pos.x - bx, this.pos.z - bz);

    if (this.onGround) {
      this.justLanded = !wasGround;
      this.landedFall = this.justLanded ? Math.max(this.fallDistance, this.lastGroundY - this.pos.y) : 0;
      this.fallDistance = 0;
      this.lastGroundY = this.pos.y;
    } else if (this.vel.y < 0) {
      const d = this.lastGroundY - this.pos.y;
      if (d > this.fallDistance) this.fallDistance = d;
    }

    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    const bobTarget = (this.onGround && !this.flying && hspeed > 0.5) ? Math.min(1, hspeed / WALK) : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * Math.min(1, dt * 8);
    this.bobPhase += dt * hspeed * 1.6;
    this.eyeH += ((this.sneaking ? P_EYE - 0.22 : P_EYE) - this.eyeH) * Math.min(1, dt * 12);
    this.landDip *= Math.max(0, 1 - dt * 6);
    if (this.justLanded && this.landedFall > 1.5) this.landDip = Math.min(0.4, this.landedFall * 0.06);
  }

  updateLook(dt) {
    const k = 1 - Math.exp(-40 * dt);
    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
  }

  moveAxis(axis, amount, vertical) {
    if (amount === 0) return;
    const old = this.pos[axis];
    this.pos[axis] += amount;
    if (this.collides()) {
      this.pos[axis] = old;
      if (vertical) {
        if (amount < 0) this.onGround = true;
        this.vel.y = 0;
      } else {
        this.vel[axis] = 0;
      }
    }
  }

  look(dx, dy, sensitivity) {
    this.targetYaw -= dx * sensitivity;
    this.targetPitch -= dy * sensitivity;
    const lim = Math.PI / 2 - 0.001;
    if (this.targetPitch > lim) this.targetPitch = lim;
    if (this.targetPitch < -lim) this.targetPitch = -lim;
    if (this.targetYaw > Math.PI) this.targetYaw -= Math.PI * 2;
    if (this.targetYaw < -Math.PI) this.targetYaw += Math.PI * 2;
  }

  applyToCamera(camera) {
    const e = this.eyePos();
    const amp = this.flying ? 0 : this.bobAmount;
    const bobY = Math.sin(this.bobPhase * 2) * 0.05 * amp;
    const bobR = Math.cos(this.bobPhase) * 0.04 * amp;
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    camera.position.set(e.x + rx * bobR, e.y + bobY, e.z + rz * bobR);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
