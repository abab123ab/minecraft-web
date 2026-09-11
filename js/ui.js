import { ITEMS, itemIconCanvas, ARMOR_SLOT_KEYS } from './items.js';
import { matchRecipe } from './crafting.js';
import { makeStack, maxStack, isTool, INV_SIZE, HOTBAR_SIZE, ARMOR_SIZE } from './inventory.js';

export class UI {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('screen');
    this.panel = document.getElementById('panel');
    this.hotbarEl = document.getElementById('hotbar');
    this.hintEl = document.getElementById('item-hint');
    this.cursorEl = document.getElementById('cursor-stack');
    this.mode = null;
    this.furnace = null;
    this.slotViews = [];
    this.hotbarViews = [];
    this.hintTimer = 0;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = this.createSlot('inv', i, '');
      el.classList.add('hot');
      this.hotbarEl.appendChild(el);
      this.hotbarViews.push(el);
    }

    this.panel.addEventListener('mousedown', (e) => this.onSlotMouse(e));
    this.panel.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    document.addEventListener('mousemove', (e) => {
      this.cursorEl.style.left = (e.clientX + 8) + 'px';
      this.cursorEl.style.top = (e.clientY + 8) + 'px';
    });
  }

  createSlot(area, index, extra) {
    const el = document.createElement('div');
    el.className = 'slot' + (extra ? ' ' + extra : '');
    el.dataset.area = area;
    el.dataset.index = String(index);
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    el.appendChild(cv);
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    el.appendChild(cnt);
    const dur = document.createElement('i');
    dur.className = 'dur';
    el.appendChild(dur);
    return el;
  }

  isOpen() { return this.mode !== null; }

  open(mode, furnace) {
    this.mode = mode;
    this.furnace = furnace || null;
    this.root.classList.remove('hidden');
    this.buildPanel();
    this.render();
  }

  close() {
    if (!this.mode) return;
    if (this.mode !== 'furnace') this.returnCraftItems();
    this.mode = null;
    this.furnace = null;
    this.root.classList.add('hidden');
    this.game.onScreenClosed();
  }

  returnCraftItems() {
    const g = this.game;
    const arr = this.mode === 'crafting' ? g.craft3 : g.craft2;
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i]) continue;
      const left = g.inventory.add(arr[i].id, arr[i].count);
      arr[i] = left > 0 ? makeStack(arr[i].id, left) : null;
      if (arr[i]) {
        this.dropStack(arr[i]);
        arr[i] = null;
      }
    }
  }

  dropStack(stack) {
    this.game.dropStack(stack);
  }

  buildPanel() {
    this.panel.innerHTML = '';
    this.slotViews = [];
    const g = this.game;

    if (this.mode === 'furnace') {
      const area = document.createElement('div');
      area.className = 'furnace-area';
      const left = document.createElement('div');
      left.className = 'furnace-col';
      const inSlot = this.createSlot('fin', 0, '');
      const fuelSlot = this.createSlot('ffuel', 0, '');
      const bars = document.createElement('div');
      bars.className = 'furnace-bars';
      const flame = document.createElement('div');
      flame.className = 'flame';
      flame.innerHTML = '<i></i>';
      const arrow = document.createElement('div');
      arrow.className = 'arrow-f';
      arrow.innerHTML = '<i></i>';
      bars.appendChild(flame);
      bars.appendChild(arrow);
      left.appendChild(inSlot);
      left.appendChild(bars);
      left.appendChild(fuelSlot);
      const outSlot = this.createSlot('fout', 0, '');
      area.appendChild(left);
      area.appendChild(outSlot);
      this.panel.appendChild(area);
      this.slotViews.push(inSlot, fuelSlot, outSlot);
      this.flameEl = flame.querySelector('i');
      this.arrowEl = arrow.querySelector('i');
    } else {
      const size = this.mode === 'crafting' ? 3 : 2;
      const area = document.createElement('div');
      area.className = 'craft-area';
      const gridEl = document.createElement('div');
      gridEl.className = 'grid g' + size;
      for (let i = 0; i < size * size; i++) {
        const el = this.createSlot('craft', i, '');
        gridEl.appendChild(el);
        this.slotViews.push(el);
      }
      const arrow = document.createElement('div');
      arrow.className = 'arrow';
      const out = this.createSlot('result', 0, '');
      area.appendChild(gridEl);
      area.appendChild(arrow);
      area.appendChild(out);
      this.panel.appendChild(area);
      this.slotViews.push(out);
    }

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = this.mode === 'furnace' ? '熔炉' : (this.mode === 'crafting' ? '工作台' : '背包');
    this.panel.insertBefore(title, this.panel.firstChild);

    const body = document.createElement('div');
    body.className = 'inv-body';

    const armorCol = document.createElement('div');
    armorCol.className = 'inv-armor';
    for (let i = 0; i < ARMOR_SIZE; i++) {
      const el = this.createSlot('armor', i, 'armor-slot');
      el.style.backgroundImage = 'url(textures/item/empty_armor_slot_' + ARMOR_SLOT_KEYS[i] + '.png)';
      armorCol.appendChild(el);
      this.slotViews.push(el);
    }
    body.appendChild(armorCol);

    const main = document.createElement('div');
    main.className = 'inv-main';
    for (let i = HOTBAR_SIZE; i < INV_SIZE; i++) {
      const el = this.createSlot('inv', i, '');
      main.appendChild(el);
      this.slotViews.push(el);
    }
    body.appendChild(main);
    this.panel.appendChild(body);

    const hb = document.createElement('div');
    hb.className = 'inv-hotbar';
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = this.createSlot('inv', i, '');
      hb.appendChild(el);
      this.slotViews.push(el);
    }
    this.panel.appendChild(hb);
    void g;
  }

  getStack(area, index) {
    const g = this.game;
    if (area === 'inv') return g.inventory.slots[index];
    if (area === 'armor') return g.inventory.armor[index];
    if (area === 'craft') {
      const arr = this.mode === 'crafting' ? g.craft3 : g.craft2;
      return arr[index];
    }
    if (area === 'result') return this.resultStack();
    if (!this.furnace) return null;
    if (area === 'fin') return this.furnace.input;
    if (area === 'ffuel') return this.furnace.fuel;
    if (area === 'fout') return this.furnace.out;
    return null;
  }

  setStack(area, index, stack) {
    const g = this.game;
    if (area === 'inv') { g.inventory.slots[index] = stack; return; }
    if (area === 'armor') { g.inventory.armor[index] = stack; return; }
    if (area === 'craft') {
      const arr = this.mode === 'crafting' ? g.craft3 : g.craft2;
      arr[index] = stack;
      return;
    }
    if (!this.furnace) return;
    if (area === 'fin') this.furnace.input = stack;
    if (area === 'ffuel') this.furnace.fuel = stack;
    if (area === 'fout') this.furnace.out = stack;
  }

  craftGrid() {
    const g = this.game;
    return this.mode === 'crafting' ? g.craft3 : g.craft2;
  }

  craftSize() { return this.mode === 'crafting' ? 3 : 2; }

  fillCraftEmpty(cur) {
    const g = this.game;
    const arr = this.craftGrid();
    for (let i = 0; i < arr.length; i++) {
      if (cur.count <= 0) break;
      if (arr[i]) continue;
      arr[i] = makeStack(cur.id, 1, cur.dmg);
      cur.count--;
    }
    if (cur.count <= 0) g.cursor = null;
  }

  resultStack() {
    const m = matchRecipe(this.craftGrid(), this.craftSize());
    return m ? makeStack(m.recipe.result, m.recipe.count) : null;
  }

  onSlotMouse(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target.closest('.slot');
    if (!el) return;
    const area = el.dataset.area;
    const index = parseInt(el.dataset.index, 10);
    const right = e.button === 2;
    const shift = e.shiftKey;
    if (area === 'result') { this.takeResult(right); this.render(); return; }
    this.interact(area, index, right, shift);
    this.render();
  }

  interact(area, index, right, shift) {
    const g = this.game;
    let slot = this.getStack(area, index);
    let cur = g.cursor;

    if (area === 'craft' && shift && cur) {
      this.fillCraftEmpty(cur);
      return;
    }

    if (area === 'fout') {
      if (!slot) return;
      if (!cur) { g.cursor = slot; this.setStack(area, index, null); }
      else if (cur.id === slot.id && cur.count + slot.count <= maxStack(cur.id)) {
        cur.count += slot.count;
        this.setStack(area, index, null);
      }
      return;
    }

    if (area === 'armor') {
      const a = cur ? ITEMS[cur.id].armor : null;
      if (a && a.slot === index) {
        this.setStack(area, index, cur);
        g.cursor = slot || null;
      } else if (slot && !cur) {
        g.cursor = slot;
        this.setStack(area, index, null);
      }
      return;
    }

    if (!cur) {
      if (!slot) return;
      if (right && ITEMS[slot.id].armor && g.inventory.equip(index)) return;
      if (right) {
        const half = Math.ceil(slot.count / 2);
        g.cursor = makeStack(slot.id, half, slot.dmg);
        const rest = slot.count - half;
        this.setStack(area, index, rest > 0 ? makeStack(slot.id, rest, slot.dmg) : null);
      } else {
        g.cursor = slot;
        this.setStack(area, index, null);
      }
      return;
    }

    if (!slot) {
      if (right) {
        this.setStack(area, index, makeStack(cur.id, 1, cur.dmg));
        cur.count--;
        if (cur.count <= 0) g.cursor = null;
      } else {
        this.setStack(area, index, cur);
        g.cursor = null;
      }
      return;
    }

    if (slot.id === cur.id && !isTool(cur.id) && slot.dmg === cur.dmg) {
      const room = maxStack(cur.id) - slot.count;
      if (room <= 0) return;
      const move = right ? Math.min(1, cur.count) : Math.min(room, cur.count);
      slot.count += move;
      cur.count -= move;
      if (cur.count <= 0) g.cursor = null;
      return;
    }

    this.setStack(area, index, cur);
    g.cursor = slot;
  }

  takeResult(right) {
    const g = this.game;
    const m = matchRecipe(this.craftGrid(), this.craftSize());
    if (!m) return;
    const out = makeStack(m.recipe.result, m.recipe.count);
    if (g.cursor && (g.cursor.id !== out.id || isTool(out.id))) return;
    if (right) {
      let times = 0;
      while (true) {
        const mm = matchRecipe(this.craftGrid(), this.craftSize());
        if (!mm) break;
        if (g.cursor && g.cursor.count + mm.recipe.count > maxStack(mm.recipe.result)) break;
        this.consumeCraft(mm);
        if (g.cursor) g.cursor.count += mm.recipe.count;
        else g.cursor = makeStack(mm.recipe.result, mm.recipe.count);
        times++;
        if (times > 64) break;
      }
      return;
    }
    if (g.cursor && g.cursor.count + out.count > maxStack(out.id)) return;
    this.consumeCraft(m);
    if (g.cursor) g.cursor.count += out.count;
    else g.cursor = out;
  }

  consumeCraft(m) {
    const grid = this.craftGrid();
    for (const i of m.cells) {
      const s = grid[i];
      if (!s) continue;
      s.count--;
      if (s.count <= 0) grid[i] = null;
    }
  }

  showHint(text) {
    this.hintEl.textContent = text;
    this.hintEl.style.opacity = '1';
    this.hintTimer = 2.2;
  }

  tick(dt) {
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.hintEl.style.opacity = '0';
    }
  }

  render() {
    const g = this.game;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = this.hotbarViews[i];
      el.classList.toggle('sel', i === g.inventory.selected);
      this.updateSlot(el, g.inventory.slots[i]);
    }
    if (!this.mode) { this.updateCursor(); return; }

    for (const el of this.slotViews) {
      const area = el.dataset.area;
      const index = parseInt(el.dataset.index, 10);
      this.updateSlot(el, this.getStack(area, index));
    }
    if (this.mode === 'furnace' && this.furnace) {
      const f = this.furnace;
      const burnPct = f.burnMax > 0 ? Math.max(0, f.burn / f.burnMax) : 0;
      this.flameEl.style.height = (burnPct * 100) + '%';
      const progPct = f.progMax > 0 ? f.prog / f.progMax : 0;
      this.arrowEl.style.width = (Math.min(1, progPct) * 100) + '%';
    }
    this.updateCursor();
  }

  updateCursor() {
    const g = this.game;
    if (!this.cursorEl.firstChild) {
      const cv = document.createElement('canvas');
      cv.width = 32; cv.height = 32;
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      this.cursorEl.appendChild(cv);
      this.cursorEl.appendChild(cnt);
    }
    this.cursorEl.style.display = g.cursor ? 'block' : 'none';
    if (g.cursor) {
      this.paint(this.cursorEl.firstChild, this.cursorEl.lastChild, g.cursor);
    }
  }

  updateSlot(el, stack) {
    this.paint(el.firstChild, el.children[1], stack);
  }

  paint(cv, cntEl, stack) {
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, 32, 32);
    cntEl.textContent = '';
    if (!stack) return;
    const icon = itemIconCanvas(this.game.atlasCanvas, ITEMS[stack.id], 32);
    ctx.drawImage(icon, 0, 0, 32, 32);
    if (stack.count > 1) cntEl.textContent = String(stack.count);
    if (isTool(stack.id)) {
      const max = ITEMS[stack.id].tool.durability;
      const frac = Math.max(0, 1 - stack.dmg / max);
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(2, 28, 28, 3);
      ctx.fillStyle = frac > 0.5 ? '#3ad13a' : frac > 0.25 ? '#e0c020' : '#d13a3a';
      ctx.fillRect(2, 28, Math.round(28 * frac), 3);
    }
  }
}
