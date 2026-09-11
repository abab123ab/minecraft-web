// 实时合成音效系统（不依赖任何音频文件，全部用 WebAudio 振荡器 + 噪声合成）
// 浏览器自动播放策略：必须在用户手势（开始按钮点击）之后调用 resume() 才会出声。

const MAT = {
  stone:   { nt: 'highpass', nf: 900,  q: 0.7, tone: 0,    gain: 1.0 },
  wood:    { nt: 'lowpass',  nf: 1600, q: 0.8, tone: 180,  tt: 'triangle', tgain: 1.0, gain: 0.9 },
  dirt:    { nt: 'lowpass',  nf: 1100, q: 0.7, tone: 0,    gain: 0.8 },
  grass:   { nt: 'lowpass',  nf: 1200, q: 0.7, tone: 0,    gain: 0.8 },
  sand:    { nt: 'lowpass',  nf: 900,  q: 0.7, tone: 0,    gain: 0.7 },
  gravel:  { nt: 'bandpass', nf: 1600, q: 0.5, tone: 0,    gain: 0.85 },
  glass:   { nt: 'highpass', nf: 2600, q: 0.6, tone: 3200, tt: 'sine', tgain: 1.0, gain: 0.7, glass: true },
  leaves:  { nt: 'highpass', nf: 2200, q: 0.6, tone: 0,    gain: 0.5 },
  wool:    { nt: 'lowpass',  nf: 600,  q: 0.7, tone: 0,    gain: 0.5 },
  metal:   { nt: 'bandpass', nf: 2000, q: 1.2, tone: 700,  tt: 'square', tgain: 1.0, gain: 0.8 }
};

// 每种生物的声音特征：[idle 起始频, idle 结束频, 受伤频, 死亡频, 音色]
const VOICE = {
  pig:      { idle: [300, 220], hurt: [200, 120], death: [260, 70],  timbre: 'triangle' },
  cow:      { idle: [150, 110], hurt: [170, 100], death: [150, 60],  timbre: 'sawtooth' },
  chicken:  { idle: [720, 560], hurt: [680, 400], death: [640, 200], timbre: 'square' },
  sheep:    { idle: [320, 260], hurt: [300, 180], death: [280, 90],  timbre: 'sawtooth' },
  zombie:   { idle: [120, 92],  hurt: [200, 120], death: [120, 55],  timbre: 'sawtooth' },
  skeleton: { idle: [90, 90],   hurt: [320, 200], death: [240, 80],  timbre: 'square' },
  creeper:  { idle: [0, 0],     hurt: [220, 140], death: [0, 0],     timbre: 'square' }
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.5;
    this.noiseBuf = null;
  }

  resume() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(this.ctx.destination);
        this.noiseBuf = this._makeNoise();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) {}
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  _now() { return this.ctx ? this.ctx.currentTime : 0; }

  _makeNoise() {
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _noise(dur, opt) {
    const o = opt || {};
    const t = o.t0 || this._now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = o.type || 'bandpass';
    filt.frequency.setValueAtTime(o.freq || 2000, t);
    if (o.freqEnd) filt.frequency.exponentialRampToValueAtTime(Math.max(40, o.freqEnd), t + dur);
    filt.Q.value = o.q || 1;
    const g = this.ctx.createGain();
    const peak = o.gain == null ? 0.5 : o.gain;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + dur * 0.15);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.03);
  }

  _tone(o) {
    const t = o.t0 || this._now();
    const osc = this.ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + o.dur);
    const g = this.ctx.createGain();
    const peak = o.gain == null ? 0.3 : o.gain;
    const atk = o.attack == null ? 0.005 : o.attack;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.linearRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + o.dur + 0.03);
  }

  _mat(cat) { return MAT[cat] || MAT.stone; }

  // ---- 方块破坏：按材质分类 ----
  breakBlock(block) {
    if (!this.ctx || this.muted) return;
    const m = this._mat(block && block.sound);
    const r = 0.85 + Math.random() * 0.3;
    this._noise(0.16 * r, { type: m.nt, freq: m.nf * r, q: m.q, gain: 0.55 * m.gain });
    if (m.tone) this._tone({ type: m.tt, f0: m.tone * r, f1: m.tone * r * 0.6, dur: 0.12 * r, gain: 0.25 * m.tgain });
    if (m.glass) {
      this._tone({ type: 'sine', f0: 3000 * r, f1: 2400, dur: 0.18, gain: 0.18 });
      this._tone({ type: 'sine', f0: 5200 * r, dur: 0.12, gain: 0.10 });
    }
  }

  // ---- 放置方块：比破坏轻一点的“咚” ----
  place(block) {
    if (!this.ctx || this.muted) return;
    const m = this._mat(block && block.sound);
    this._noise(0.1, { type: m.nt, freq: m.nf * 0.8, q: m.q, gain: 0.3 * m.gain });
    if (m.tone) this._tone({ type: m.tt, f0: m.tone, f1: m.tone * 0.7, dur: 0.09, gain: 0.14 * m.tgain });
    else this._tone({ type: 'sine', f0: 150, f1: 90, dur: 0.1, gain: 0.2 });
  }

  // ---- 脚步：按脚下地面材质，短而轻 ----
  step(cat) {
    if (!this.ctx || this.muted) return;
    const m = this._mat(cat);
    this._noise(0.07, { type: m.nt, freq: m.nf * 0.8, q: m.q, gain: 0.28 * m.gain });
    if (m.tone) this._tone({ type: m.tt, f0: m.tone, dur: 0.06, gain: 0.12 * m.tgain });
  }

  // ---- 落地：较重的闷响 ----
  land() {
    if (!this.ctx || this.muted) return;
    this._noise(0.18, { type: 'lowpass', freq: 500, q: 0.5, gain: 0.6 });
    this._tone({ type: 'sine', f0: 110, f1: 55, dur: 0.18, gain: 0.5 });
  }

  // ---- 玩家受伤：刺耳的下滑音 ----
  hurt() {
    if (!this.ctx || this.muted) return;
    this._tone({ type: 'sawtooth', f0: 240, f1: 120, dur: 0.18, gain: 0.4 });
    this._noise(0.1, { type: 'lowpass', freq: 1500, q: 0.5, gain: 0.25 });
  }

  // ---- 吃东西：几下咀嚼 ----
  eat() {
    if (!this.ctx || this.muted) return;
    const base = this._now();
    for (let i = 0; i < 3; i++) {
      this._noise(0.05, { type: 'lowpass', freq: 1100, q: 0.6, gain: 0.3, t0: base + i * 0.13 });
    }
  }

  // ---- 拾取物品：轻快的两声“叮” ----
  pickup() {
    if (!this.ctx || this.muted) return;
    const t = this._now();
    this._tone({ type: 'sine', f0: 880, f1: 1320, dur: 0.08, gain: 0.3, t0: t });
    this._tone({ type: 'sine', f0: 1320, f1: 1760, dur: 0.08, gain: 0.22, t0: t + 0.06 });
  }

  // ---- 生物环境音（偶尔发出，靠近玩家才播）----
  mobIdle(type) {
    if (!this.ctx || this.muted) return;
    if (type === 'creeper') { this.creeperHiss(0.5); return; }
    if (type === 'chicken') {
      const t = this._now();
      this._tone({ type: 'square', f0: 720, f1: 560, dur: 0.07, gain: 0.18, t0: t });
      this._noise(0.05, { type: 'highpass', freq: 1800, q: 0.6, gain: 0.12, t0: t + 0.06 });
      return;
    }
    if (type === 'skeleton') {
      const t = this._now();
      for (let i = 0; i < 3; i++) this._noise(0.04, { type: 'bandpass', freq: 2600, q: 1.4, gain: 0.16, t0: t + i * 0.07 });
      return;
    }
    const v = VOICE[type] || VOICE.zombie;
    const r = 0.92 + Math.random() * 0.16;
    this._tone({ type: v.timbre, f0: v.idle[0] * r, f1: v.idle[1] * r, dur: type === 'cow' ? 0.4 : 0.2, gain: 0.22 });
  }

  // ---- 生物受伤 ----
  mobHurt(type) {
    if (!this.ctx || this.muted) return;
    const v = VOICE[type] || VOICE.zombie;
    const r = 0.9 + Math.random() * 0.2;
    this._tone({ type: v.timbre, f0: v.hurt[0] * r, f1: v.hurt[1] * r, dur: 0.15, gain: 0.3 });
    this._noise(0.09, { type: 'lowpass', freq: 1200, q: 0.5, gain: 0.2 });
  }

  // ---- 生物死亡：下滑哀鸣（按种类定音色）----
  mobDeath(type) {
    if (!this.ctx || this.muted) return;
    if (type === 'creeper') { this._noise(0.5, { type: 'highpass', freq: 2600, q: 0.6, gain: 0.28 }); return; }
    const v = VOICE[type] || VOICE.zombie;
    const r = 0.9 + Math.random() * 0.15;
    this._tone({ type: v.timbre, f0: v.death[0] * r, f1: v.death[1] * r, dur: 0.35, gain: 0.32 });
    this._noise(0.28, { type: 'lowpass', freq: 1400, q: 0.5, gain: 0.18 });
  }

  // ---- 近战挥击：短促“嗖” ----
  mobAttack(type) {
    if (!this.ctx || this.muted) return;
    this._noise(0.14, { type: 'bandpass', freq: 900, freqEnd: 220, q: 0.8, gain: 0.22 });
  }

  // ---- 苦力怕引信：嘶嘶声 ----
  creeperHiss(scale) {
    if (!this.ctx || this.muted) return;
    const g = (scale == null ? 1 : scale) * 0.32;
    this._noise(0.6, { type: 'highpass', freq: 2400, q: 0.5, gain: g, freqEnd: 3200 });
  }

  // ---- 爆炸：低频轰鸣 + 噪声下扫 ----
  explode() {
    if (!this.ctx || this.muted) return;
    this._noise(0.7, { type: 'lowpass', freq: 2000, q: 0.4, gain: 0.9, freqEnd: 200 });
    this._tone({ type: 'sine', f0: 90, f1: 40, dur: 0.7, gain: 0.9 });
    this._tone({ type: 'square', f0: 140, f1: 55, dur: 0.5, gain: 0.3 });
  }

  // ---- 射箭：弓弦“嘣” ----
  shoot() {
    if (!this.ctx || this.muted) return;
    this._tone({ type: 'triangle', f0: 600, f1: 180, dur: 0.12, gain: 0.35 });
    this._noise(0.06, { type: 'highpass', freq: 1500, q: 0.5, gain: 0.15 });
  }

  // ---- 熔炉出炉：两声柔和的“叮” ----
  furnaceReady() {
    if (!this.ctx || this.muted) return;
    const t = this._now();
    this._tone({ type: 'sine', f0: 880, dur: 0.12, gain: 0.3, t0: t });
    this._tone({ type: 'sine', f0: 1175, dur: 0.18, gain: 0.3, t0: t + 0.12 });
  }
}
