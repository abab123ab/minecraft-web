import * as THREE from './vendor/three.module.js';
import { HEIGHT } from './worlddef.js';

export const DAY_LENGTH = 600;
export const SLEEP_SPEED = 80;
export const SKY_DAY = 0x78a7ff;
export const SKY_NIGHT = 0x05070f;
export const SKY_DUSK = 0xd9803f;

export class Sky {
  constructor(scene, camera, world) {
    this.scene = scene;
    this.camera = camera;
    this.world = world;
    this.timeOfDay = 0.28;
    this.isDay = true;
    this.isNight = false;
    this.light = 1;
    this.baseFov = camera.fov;
    this.build();
  }

  build() {
    const loader = new THREE.TextureLoader();
    // 太阳、月亮、云跟方块贴图一样是「显示器颜色」，都要按 sRGB 解码。
    // 漏掉这一行它们会比预期更亮更淡，蓝天里的云会糊成一片灰白。
    const pixel = (t) => {
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };

    // sun.png / moon_phases.png 都没有 alpha 通道 —— 逐像素量过，两张图的 alpha 全是 255。
    // 它们是「黑底上的发光图」：太阳是黑底 + 一圈暖白光晕，月亮是深蓝底 + 月相。
    // 直接当 sprite 贴上去，就是一个不透明的黑方块飘在天上（截图里看着像一块烧焦的砖）。
    //
    // 这里按亮度反推 alpha：alpha = max(r,g,b)，再把 rgb 反预乘回去。
    // 混合时颜色会乘一次 alpha，不除回去的话发光部分会整体变暗；
    // 除回去之后，黑底上的原画面和原来一模一样，只是黑底变成透明的了。
    // 亮度低于 48 的一律当背景抹掉 —— 月亮那格的黑底就是靠这一刀去掉的（月亮本体 64 以上）。
    const glow = (t) => {
      const img = t.image;
      if (!img || !img.width) return t;
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const p = d.data;
      for (let i = 0; i < p.length; i += 4) {
        const a = Math.max(p[i], p[i + 1], p[i + 2]);
        if (a < 48) { p[i] = 0; p[i + 1] = 0; p[i + 2] = 0; p[i + 3] = 0; continue; }
        const k = 255 / a;
        p[i] = Math.min(255, p[i] * k);
        p[i + 1] = Math.min(255, p[i + 1] * k);
        p[i + 2] = Math.min(255, p[i + 2] * k);
        p[i + 3] = a;
      }
      ctx.putImageData(d, 0, 0);
      t.image = c;
      t.needsUpdate = true;
      return t;
    };

    const sunTex = glow(pixel(loader.load('textures/environment/sun.png', glow)));
    const moonTex = pixel(loader.load('textures/environment/moon_phases.png', glow));
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

    const cloudTex = pixel(loader.load('textures/environment/clouds.png'));
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    cloudTex.repeat.set(20, 20);
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

  setFog(distance) {
    this.scene.fog = new THREE.Fog(SKY_DAY, distance * 0.55, distance * 0.95);
  }

  updateFov(dt, sprinting) {
    const target = this.baseFov + (sprinting ? 8 : 0);
    const diff = target - this.camera.fov;
    if (Math.abs(diff) < 0.05) return;
    this.camera.fov += diff * Math.min(1, dt * 8);
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
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
    this.light = light;
    this.world.matOpaque.color.setRGB(light, light, light * (0.96 + 0.04 * amt));
    this.world.matCutout.color.setRGB(light, light, light * (0.96 + 0.04 * amt));
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
}
