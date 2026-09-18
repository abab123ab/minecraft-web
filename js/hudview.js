import { ITEMS, armorStats, itemIconCanvas } from './items.js';
import { biomeAt } from './worldgen.js';

const BIOME_CN = {
  plains: '平原', forest: '森林', desert: '沙漠', snowy: '雪原', mountains: '山地'
};

export function updateHud(game) {
  const p = game.player;
  const st = armorStats(game.inventory.armor);
  game.survival.setArmor(st.points, st.toughness);
  game.hud.update(game.survival);
  updateHand(game);
  const held = game.inventory.held();
  const bio = biomeAt(Math.floor(p.pos.x), Math.floor(p.pos.z));
  const bioName = BIOME_CN[bio] || bio;
  game.debugEl.textContent = game.fps + ' FPS · 区块 ' + game.world.chunks.size +
    ' · 待更新 ' + game.world.dirty.size + ' · 渲染距离 ' + game.world.renderDistance +
    ' · 生物 ' + game.mobs.count() + (game.isNight ? ' · 夜晚' : ' · 白天');
  game.coordEl.textContent = 'XYZ ' + p.pos.x.toFixed(1) + ' / ' + p.pos.y.toFixed(1) + ' / ' + p.pos.z.toFixed(1) +
    ' · ' + bioName + ' · ' + (held ? ITEMS[held.id].label : '空手') +
    (p.flying ? ' · 飞行' : '');
}

export function updateHand(game) {
  const el = game.handEl;
  if (!el) return;
  const held = game.inventory.held();
  if (!held) {
    if (game.lastHandId !== -1) { el.style.display = 'none'; game.lastHandId = -1; }
    return;
  }
  if (el.style.display === 'none') el.style.display = 'block';
  if (game.lastHandId !== held.id) {
    const ctx = el.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 72, 72);
    ctx.drawImage(itemIconCanvas(game.atlasCanvas, ITEMS[held.id], 72), 0, 0, 72, 72);
    game.lastHandId = held.id;
  }
  const amp = game.player.flying ? 0 : game.player.bobAmount;
  const bobY = Math.sin(game.player.bobPhase * 2) * 7 * amp;
  const bobX = Math.cos(game.player.bobPhase) * 5 * amp;
  const swing = game.mining ? Math.sin(performance.now() / 80) * 16 : 0;
  el.style.transform = 'translate(' + bobX.toFixed(2) + 'px,' + bobY.toFixed(2) + 'px) rotate(' + swing.toFixed(1) + 'deg)';
}
