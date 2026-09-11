import { CHUNK } from './world.js';

export const SAVE_KEY = 'mcweb.save.v1';
const VERSION = 1;
const EDIT_BUDGET = 3.5 * 1024 * 1024;

// -1 表示「原值未知」（从存档读回的改动），永远不会等于当前值，因此必定被保留
function serializeEdits(edits, spawn) {
  const scx = Math.floor(spawn.x / CHUNK), scz = Math.floor(spawn.z / CHUNK);
  const list = [];
  for (const [k, m] of edits) {
    const o = {};
    for (const [idx, rec] of m) if (rec[1] !== rec[0]) o[idx] = rec[1];
    const keys = Object.keys(o);
    if (!keys.length) continue;
    const parts = k.split('|');
    const d = (Number(parts[0]) - scx) ** 2 + (Number(parts[1]) - scz) ** 2;
    list.push({ k, o, d, size: JSON.stringify(o).length + k.length + 8 });
  }
  let total = list.reduce((a, b) => a + b.size, 0);
  if (total > EDIT_BUDGET) {
    list.sort((a, b) => b.d - a.d);
    while (total > EDIT_BUDGET && list.length) total -= list.shift().size;
  }
  const out = {};
  for (const it of list) out[it.k] = it.o;
  return out;
}

function deserializeEdits(obj) {
  const m = new Map();
  for (const k in obj) {
    const inner = new Map();
    for (const idx in obj[k]) inner.set(Number(idx), [-1, obj[k][idx]]);
    m.set(k, inner);
  }
  return m;
}

const stack = (s) => (s ? [s.id, s.count, s.dmg || 0] : null);
const unstack = (a) => (a ? { id: a[0], count: a[1], dmg: a[2] || 0 } : null);

export function serialize(game) {
  const p = game.player, v = game.survival, inv = game.inventory;
  return {
    version: VERSION,
    time: game.timeOfDay,
    player: {
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      yaw: p.targetYaw, pitch: p.targetPitch,
      flying: !!p.flying,
      spawn: { x: game.spawnPoint.x, y: game.spawnPoint.y, z: game.spawnPoint.z }
    },
    survival: {
      health: v.health, hunger: v.hunger, saturation: v.saturation,
      exhaustion: v.exhaustion, airSupply: v.airSupply
    },
    inventory: {
      slots: inv.slots.map(stack),
      armor: inv.armor.map(stack),
      selected: inv.selected
    },
    furnaces: Array.from(game.furnaces, ([k, f]) => [k, {
      input: stack(f.input), fuel: stack(f.fuel), out: stack(f.out),
      burn: f.burn, burnMax: f.burnMax, prog: f.prog, progMax: f.progMax
    }]),
    edits: serializeEdits(game.world.edits, game.spawnPoint)
  };
}

export function saveGame(game) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serialize(game)));
    return true;
  } catch (e) {
    return false;
  }
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.version !== VERSION) return null;
    s.edits = deserializeEdits(s.edits || {});
    return s;
  } catch (e) {
    return null;
  }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}

export function restoreInventory(inv, data, INV_SIZE, ARMOR_SIZE) {
  if (!data) return;
  const slots = (data.slots || []).map(unstack);
  while (slots.length < INV_SIZE) slots.push(null);
  const armor = (data.armor || []).map(unstack);
  while (armor.length < ARMOR_SIZE) armor.push(null);
  inv.slots = slots.slice(0, INV_SIZE);
  inv.armor = armor.slice(0, ARMOR_SIZE);
  inv.selected = data.selected || 0;
}

export function restoreFurnaces(game, list) {
  if (!list) return;
  for (const [k, f] of list) {
    game.furnaces.set(k, {
      input: unstack(f.input), fuel: unstack(f.fuel), out: unstack(f.out),
      burn: f.burn || 0, burnMax: f.burnMax || 0, prog: f.prog || 0, progMax: f.progMax || 1
    });
  }
}
