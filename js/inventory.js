import { ITEMS } from './items.js';

export const HOTBAR_SIZE = 9;
export const INV_SIZE = 36;
export const ARMOR_SIZE = 4;

export function makeStack(id, count, dmg) {
  return { id, count: count === undefined ? 1 : count, dmg: dmg || 0 };
}

export function maxStack(id) { return ITEMS[id].stack; }
export function isTool(id) { return !!ITEMS[id].tool; }

export class Inventory {
  constructor() {
    this.slots = new Array(INV_SIZE).fill(null);
    this.armor = new Array(ARMOR_SIZE).fill(null);
    this.selected = 0;
  }

  held() { return this.slots[this.selected]; }

  equip(index) {
    const s = this.slots[index];
    if (!s || !ITEMS[s.id].armor) return false;
    const slot = ITEMS[s.id].armor.slot;
    const old = this.armor[slot];
    this.armor[slot] = s;
    this.slots[index] = old || null;
    return true;
  }

  unequip(slot) {
    const s = this.armor[slot];
    if (!s) return false;
    const left = this.add(s.id, s.count);
    if (left >= s.count) return false;
    this.armor[slot] = null;
    return true;
  }

  add(id, count, dmg) { return this.addTo(id, count, dmg, 0, INV_SIZE - 1); }

  // 只在 [from,to] 这段槽位里放。shift 快速转移靠它把物品限定在背包或热键栏里。
  // dmg 必须带上：工具挪一次位置就变全新的，是很久之前就埋下的坑。
  addTo(id, count, dmg, from, to) {
    let left = count;
    const max = maxStack(id);
    const tool = isTool(id);
    if (!tool) {
      for (let i = from; i <= to && left > 0; i++) {
        const s = this.slots[i];
        if (s && s.id === id && s.count < max) {
          const take = Math.min(max - s.count, left);
          s.count += take;
          left -= take;
        }
      }
    }
    for (let i = from; i <= to && left > 0; i++) {
      if (this.slots[i] !== null) continue;
      const take = tool ? 1 : Math.min(max, left);
      this.slots[i] = makeStack(id, take, dmg);
      left -= take;
    }
    return left;
  }

  // [from,to] 还能装下几个。先问容量再放，避免「只塞进去一半、材料又退不回来」。
  capacity(id, from, to) {
    const max = maxStack(id);
    const tool = isTool(id);
    let cap = 0;
    for (let i = from; i <= to; i++) {
      const s = this.slots[i];
      if (!s) cap += max;
      else if (!tool && s.id === id) cap += max - s.count;
    }
    return cap;
  }

  removeAt(i, n) {
    const s = this.slots[i];
    if (!s) return 0;
    const take = Math.min(n, s.count);
    s.count -= take;
    if (s.count <= 0) this.slots[i] = null;
    return take;
  }

  damageHeld(amount) {
    const s = this.held();
    if (!s || !isTool(s.id)) return;
    s.dmg += amount;
    if (s.dmg >= ITEMS[s.id].tool.durability) this.slots[this.selected] = null;
  }

  consumeHeld(n) {
    return this.removeAt(this.selected, n || 1);
  }
}
