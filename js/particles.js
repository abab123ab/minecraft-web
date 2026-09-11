import * as THREE from './vendor/three.module.js';
import { TILE_INDEX, tileUV } from './textures.js';

const LIFE = 0.6;
const GRAVITY = 14;

export class Particles {
  constructor(scene, atlasTexture) {
    this.scene = scene;
    this.tex = atlasTexture;
    this.list = [];
  }

  burst(x, y, z, tileName, count) {
    const ti = TILE_INDEX[tileName];
    if (ti === undefined) return;
    const uv = tileUV(ti);
    const geo = new THREE.PlaneGeometry(0.2, 0.2);
    const a = geo.attributes.uv;
    a.setXY(0, uv.u0, uv.v1);
    a.setXY(1, uv.u1, uv.v1);
    a.setXY(2, uv.u0, uv.v0);
    a.setXY(3, uv.u1, uv.v0);
    a.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, side: THREE.DoubleSide, depthWrite: false
    });
    const group = { geo, mat, parts: [], t: 0 };
    const n = count || 10;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(
        x + Math.random() * 0.7 + 0.15,
        y + Math.random() * 0.7 + 0.15,
        z + Math.random() * 0.7 + 0.15
      );
      m.renderOrder = 5;
      this.scene.add(m);
      group.parts.push({
        m,
        v: new THREE.Vector3((Math.random() - 0.5) * 2.4, Math.random() * 2.6 + 1.0, (Math.random() - 0.5) * 2.4)
      });
    }
    this.list.push(group);
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      g.t += dt;
      const k = g.t / LIFE;
      if (k >= 1) {
        for (const p of g.parts) this.scene.remove(p.m);
        g.geo.dispose();
        g.mat.dispose();
        this.list.splice(i, 1);
        continue;
      }
      g.mat.opacity = 1 - k * k;
      for (const p of g.parts) {
        p.v.y -= GRAVITY * dt;
        p.m.position.addScaledVector(p.v, dt);
      }
    }
  }

  clear() {
    for (const g of this.list) {
      for (const p of g.parts) this.scene.remove(p.m);
      g.geo.dispose();
      g.mat.dispose();
    }
    this.list.length = 0;
  }
}
