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

  add(id, count) {
    let left = count;
    const max = maxStack(id);
    if (isTool(id)) {
      for (let i = 0; i < INV_SIZE && left > 0; i++) {
        if (this.slots[i] === null) { this.slots[i] = makeStack(id, 1); left--; }
      }
      return left;
    }
    for (let i = 0; i < INV_SIZE && left > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < max) {
        const take = Math.min(max - s.count, left);
        s.count += take;
        left -= take;
      }
    }
    for (let i = 0; i < INV_SIZE && left > 0; i++) {
      if (this.slots[i] === null) {
        const take = Math.min(max, left);
        this.slots[i] = makeStack(id, take);
        left -= take;
      }
    }
    return left;
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
