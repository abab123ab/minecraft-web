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

    // clouds.png 是 256x256 的「1 位」掩码（调色板只有全透 / 全不透两种 alpha），
    // 原版把「一个贴图像素」摊成 12 格。第一版在这里 repeat 了 20 遍、铺在 2600 的平面上，
    // 于是一个像素只有 2600 / (256*20) = 0.5 格 —— 比原版小了 24 倍，
    // 那么细的抖动噪点在地面上看就是一片糊在天空上的电视雪花，根本不像云。
    // 改成整张贴图刚好铺满 256*12 格。
    const CLOUD_TEXEL = 12;
    const CLOUD_SPAN = 256 * CLOUD_TEXEL;
    const cloudTex = pixel(loader.load('textures/environment/clouds.png'));
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    cloudTex.repeat.set(1, 1);
    this.clouds = new THREE.Mesh(
      new THREE.PlaneGeometry(CLOUD_SPAN, CLOUD_SPAN),
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
    // 太阳高度 -> 环境光系数。下限 0.12 是「深夜」的底：以前是 0.30，
    // 加上 light 的 0.30 偏移，两头一夹，午夜的地面只有白天的 0.51 亮 ——
    // 实测石墙白天 rgb 118、午夜 86，天空却已经掉到 #05070f 全黑，地面和天空对不上。
    // 注意渲染是 sRGB 输出，这个系数作用在线性空间，感知亮度不是按比例掉：
    // 系数 0.36 时石墙还能到 72/255，要真的暗下来得把系数压到 0.17（石墙约 53/255）。
    const amt = Math.max(0.12, Math.min(1, elev * 1.6 + 0.45));
    const night = new THREE.Color(SKY_NIGHT);
    const day = new THREE.Color(SKY_DAY);
    const dusk = new THREE.Color(SKY_DUSK);
    // 三种天色之间是直线对插的，而橙 (#d9803f) 和蓝 (#78a7ff) 在线性空间对插，
    // 中点必然塌成灰紫粉 —— 把整条曲线算出来看，饱和度最低点 0.22（#b195c0）
    // 恰好落在太阳高度 0，也就是日落那一刻，整个天连雾一起变成一片粉。
    // 改的不是颜色而是窗口：太阳贴着地平线那一段（0.06..-0.10）整段停在暖橙，
    // 橙 -> 蓝的过渡挪到太阳升起来之上、缩窄到 0.06..0.20（约 13 秒）——
    // 发灰那一下从「日落那一刻」变成太阳升高后的一闪。
    // 往夜的淡出也从 -0.50 提到 -0.35：原来拖得太长，isNight 早就 true 了、
    // 世界光照也已经到底，天上却还是一整片亮橙，两头对不上。
    let sky;
    if (elev > 0.20) sky = day;
    else if (elev > 0.06) sky = dusk.clone().lerp(day, (elev - 0.06) / 0.14);
    else if (elev > -0.10) sky = dusk;
    else sky = night.clone().lerp(dusk, Math.max(0, (elev + 0.35) / 0.25));
    this.scene.background = sky;
    if (this.scene.fog) this.scene.fog.color.copy(sky);
    // 夜里世界得真的变暗。原来这里是 0.30 + 0.70 * amt，而 amt 的下限又是 0.30，
    // 两头一夹，午夜的地面亮度是白天的 0.51 —— 实测石墙白天 rgb 118、午夜 86，
    // 只暗了 27%，可天空已经掉到 #05070f 全黑，地面和天空完全对不上，火把也失去意义。
    const light = 0.08 + 0.92 * amt;
    this.light = light;
    this.world.matOpaque.color.setRGB(light, light, light * (0.96 + 0.04 * amt));
    this.world.matCutout.color.setRGB(light, light, light * (0.96 + 0.04 * amt));
    this.world.matWater.color.setRGB(light, light, light);
    this.world.matGlass.color.setRGB(light, light, light);
    // 云是 MeshBasicMaterial（不受光照），不跟着昼夜走 —— 夜里世界黑成一片，
    // 云还是死白的一团，比脚下的地面还亮。按 sky light 同比压暗
    // （白天 light=1.0 时这支是恒等变换，一点不影响白天的观感）。
    this.clouds.material.color.setRGB(light, light, light);
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
