import { ITEMS, itemIconCanvas, ARMOR_SLOT_KEYS } from './items.js';
import { matchRecipe } from './crafting.js';
import { makeStack, maxStack, isTool, INV_SIZE, HOTBAR_SIZE, ARMOR_SIZE } from './inventory.js';

// 两次点击间隔小于这个值就算双击（收拢同种物品）
const DOUBLE_CLICK_MS = 300;

export class UI {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('screen');
    this.panel = document.getElementById('panel');
    this.hotbarEl = document.getElementById('hotbar');
    this.hintEl = document.getElementById('item-hint');
    this.cursorEl = document.getElementById('cursor-stack');
    this.tipEl = document.getElementById('slot-tip');
    this.mode = null;
    this.furnace = null;
    this.slotViews = [];
    this.hotbarViews = [];
    this.hintTimer = 0;
    this.hover = null;
    this.mouse = { x: 0, y: 0 };
    this.press = null;      // 还没落子的那次按下；拖拽分发要等 mouseup 才知道划过哪几格
    this.dragSlots = [];
    this.lastClick = null;  // 认双击用

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = this.createSlot('inv', i, '');
      el.classList.add('hot');
      this.hotbarEl.appendChild(el);
      this.hotbarViews.push(el);
    }

    this.panel.addEventListener('mousedown', (e) => this.onSlotDown(e));
    this.panel.addEventListener('contextmenu', (e) => e.preventDefault());
    this.panel.addEventListener('mousemove', (e) => {
      const el = e.target.closest('.slot');
      this.hover = el ? { area: el.dataset.area, index: parseInt(el.dataset.index, 10) } : null;
      if (this.press && this.hover) this.dragTrack(this.hover);
      this.updateTip();
    });
    this.panel.addEventListener('mouseleave', () => {
      this.hover = null;
      this.updateTip();
    });
    // 松手挂在 window 上：拖到面板外面再松手也要正常落子
    window.addEventListener('mouseup', () => this.onSlotUp());
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    document.addEventListener('mousemove', (e) => {
      this.cursorEl.style.left = (e.clientX + 8) + 'px';
      this.cursorEl.style.top = (e.clientY + 8) + 'px';
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      if (this.hover) this.placeTip();
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
    this.hover = null;
    this.root.classList.remove('hidden');
    this.buildPanel();
    this.render();
  }

  close() {
    if (!this.mode) return;
    const g = this.game;
    if (g.cursor) this.returnCursor();
    if (this.mode !== 'furnace') this.returnCraftItems();
    this.mode = null;
    this.furnace = null;
    this.hover = null;
    this.press = null;
    this.dragSlots = [];
    this.lastClick = null;
    this.tipEl.style.display = 'none';
    this.root.classList.add('hidden');
    this.game.onScreenClosed();
  }

  // 关界面时手上（光标）提着的那组必须放回去，放不下就丢到地上。
  // 原来完全不处理 → 图标一直挂在屏幕上，那组东西也拿不回来。
  returnCursor() {
    const g = this.game;
    const c = g.cursor;
    if (!c) return;
    g.cursor = null;
    const left = g.inventory.add(c.id, c.count, c.dmg);
    if (left > 0) this.dropStack(makeStack(c.id, left, c.dmg));
  }

  returnCraftItems() {
    const g = this.game;
    const arr = this.mode === 'crafting' ? g.craft3 : g.craft2;
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i]) continue;
      const left = g.inventory.add(arr[i].id, arr[i].count, arr[i].dmg);
      arr[i] = left > 0 ? makeStack(arr[i].id, left, arr[i].dmg) : null;
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

  onSlotDown(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target.closest('.slot');
    if (!el) return;
    const area = el.dataset.area;
    const index = parseInt(el.dataset.index, 10);
    const right = e.button === 2;
    const shift = e.shiftKey;
    const g = this.game;

    if (area === 'result') { this.takeResult(right, shift); this.render(); return; }
    if (shift) {
      // 手上已经提着东西时，shift 点合成格 = 把材料铺进空格（老行为，别动）
      if (area === 'craft' && g.cursor) this.interact(area, index, right, shift);
      else this.quickMove(area, index);
      this.render();
      return;
    }

    // 双击收拢：第一下已经把物品拿到光标上了，第二下把背包里所有同种物品一起收过来
    const now = performance.now();
    const dbl = !right && this.lastClick && this.lastClick.area === area &&
      this.lastClick.index === index && now - this.lastClick.t < DOUBLE_CLICK_MS;
    this.lastClick = { area, index, t: now };
    this.press = null;
    this.dragSlots = [];
    if (dbl && g.cursor && !isTool(g.cursor.id)) {
      this.gather();
      this.render();
      return;
    }

    // 「拿起」类操作不改槽位内容，立刻生效；「往槽里放东西」的那一半留到 mouseup ——
    // 拖拽分发只有在鼠标划过的过程中才知道要分给哪几格。
    if (!g.cursor) {
      this.interact(area, index, right, shift);
      if (g.cursor) {
        this.press = { area, index, right, picked: true };
        this.dragSlots = [{ area, index }];
      }
    } else {
      this.press = { area, index, right, picked: false };
      this.dragSlots = [{ area, index }];
    }
    this.render();
  }

  onSlotUp() {
    const press = this.press;
    if (!press) return;
    this.press = null;
    const all = this.dragSlots;
    this.dragSlots = [];
    if (!this.mode) return;
    // 起点算不算分发目标：从起点「拿起」的不算 —— 把东西原样放回原处没意义；
    // 光标本来就提着东西、起点只是要去的那一格，那就算。
    const targets = press.picked
      ? all.filter((t) => !(t.area === press.area && t.index === press.index))
      : all;
    const placed = this.distribute(targets, press.right);
    // 一格都没放成（比如起点上是另一种物品，本该做交换）→ 退回普通点击
    if (placed === 0 && !press.picked) this.interact(press.area, press.index, press.right, false);
    this.render();
  }

  dragTrack(h) {
    const last = this.dragSlots[this.dragSlots.length - 1];
    if (last && last.area === h.area && last.index === h.index) return;
    if (this.dragSlots.some((s) => s.area === h.area && s.index === h.index)) return;
    this.dragSlots.push({ area: h.area, index: h.index });
  }

  // 这一格能不能收下光标上那个物品（拖拽分发用）。产物格、家具产物格、防具格都不参与。
  canAccept(area, index, id) {
    if (area === 'result' || area === 'fout' || area === 'armor') return false;
    const st = this.getStack(area, index);
    if (!st) return true;
    return !isTool(id) && st.id === id && st.count < maxStack(id);
  }

  // 拖拽分发：右键每格放 1 个；左键把光标上那组按目标格数均分，余数留在光标上。
  // 返回实际放出去的数量。
  distribute(targets, right) {
    const g = this.game;
    const cur = g.cursor;
    if (!cur || targets.length === 0) return 0;
    const usable = targets.filter((t) => this.canAccept(t.area, t.index, cur.id));
    if (usable.length === 0) return 0;
    const per = right ? 1 : Math.max(1, Math.floor(cur.count / usable.length));
    const max = maxStack(cur.id);
    let placed = 0;
    for (const t of usable) {
      if (cur.count <= 0) break;
      const st = this.getStack(t.area, t.index);
      const room = st ? max - st.count : max;
      const put = Math.min(per, room, cur.count);
      if (put <= 0) continue;
      if (st) st.count += put;
      else this.setStack(t.area, t.index, makeStack(cur.id, put, cur.dmg));
      cur.count -= put;
      placed += put;
    }
    if (cur.count <= 0) g.cursor = null;
    return placed;
  }

  // 双击收拢：把背包和合成格里所有同种物品都收到光标上（工具各占一格，不参与）
  gather() {
    const g = this.game;
    const cur = g.cursor;
    if (!cur || isTool(cur.id)) return 0;
    const max = maxStack(cur.id);
    const spots = [];
    for (let i = 0; i < INV_SIZE; i++) spots.push(['inv', i]);
    const grid = this.craftGrid();
    for (let i = 0; i < grid.length; i++) spots.push(['craft', i]);
    let moved = 0;
    for (const [area, i] of spots) {
      if (cur.count >= max) break;
      const s = this.getStack(area, i);
      if (!s || s.id !== cur.id) continue;
      const take = Math.min(max - cur.count, s.count);
      if (take <= 0) continue;
      s.count -= take;
      cur.count += take;
      moved += take;
      if (s.count <= 0) this.setStack(area, i, null);
    }
    return moved;
  }

  // shift 点击 = 快速转移：背包↔热键栏、合成格/熔炉/防具 → 背包。
  // 目标区放不下就原地不动，不做半截操作。
  quickMove(area, index) {
    const g = this.game;
    const st = this.getStack(area, index);
    if (!st) return;
    let left;
    if (area === 'inv') {
      const toHotbar = index >= HOTBAR_SIZE;
      const from = toHotbar ? 0 : HOTBAR_SIZE;
      const to = toHotbar ? HOTBAR_SIZE - 1 : INV_SIZE - 1;
      left = g.inventory.addTo(st.id, st.count, st.dmg, from, to);
    } else {
      left = g.inventory.add(st.id, st.count, st.dmg);
    }
    if (left >= st.count) return;
    this.setStack(area, index, left > 0 ? makeStack(st.id, left, st.dmg) : null);
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

  takeResult(right, shift) {
    const g = this.game;
    if (shift) { this.craftAll(); return; }
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

  // shift 点产物：一路合成到材料用完或背包塞不下，产物直接进背包（不经过光标）。
  // 先问容量再动手 —— 先 add 后判满会「塞进去一半、材料还留着」，凭空多出物品。
  craftAll() {
    const g = this.game;
    for (let n = 0; n < 64; n++) {
      const m = matchRecipe(this.craftGrid(), this.craftSize());
      if (!m) return;
      if (g.inventory.capacity(m.recipe.result, 0, INV_SIZE - 1) < m.recipe.count) return;
      g.inventory.add(m.recipe.result, m.recipe.count);
      this.consumeCraft(m);
    }
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

  // 界面开着时按 Q：丢鼠标悬停的那一格，而不是热键栏里手持的那一格。
  // 产物格和熔炉产物格不给丢（丢了等于白烧）。
  dropHovered(whole) {
    const g = this.game;
    const h = this.hover;
    if (!h || h.area === 'result' || h.area === 'fout') return false;
    const st = this.getStack(h.area, h.index);
    if (!st) return false;
    const n = whole ? st.count : 1;
    st.count -= n;
    if (st.count <= 0) this.setStack(h.area, h.index, null);
    g.spawnDrop(st.id, n);
    this.render();
    return true;
  }

  updateTip() {
    const st = this.hover && this.mode ? this.getStack(this.hover.area, this.hover.index) : null;
    if (!st) { this.tipEl.style.display = 'none'; return; }
    const it = ITEMS[st.id];
    let text = it.label;
    if (st.count > 1) text += ' ×' + st.count;
    if (isTool(st.id)) {
      const max = it.tool.durability;
      text += '　耐久 ' + Math.max(0, max - st.dmg) + '/' + max;
    }
    this.tipEl.textContent = text;
    this.tipEl.style.display = 'block';
    this.placeTip();
  }

  placeTip() {
    const w = this.tipEl.offsetWidth, h = this.tipEl.offsetHeight;
    let x = this.mouse.x + 14, y = this.mouse.y + 14;
    if (x + w > window.innerWidth) x = this.mouse.x - w - 8;
    if (y + h > window.innerHeight) y = this.mouse.y - h - 8;
    this.tipEl.style.left = x + 'px';
    this.tipEl.style.top = y + 'px';
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
    if (!this.mode) { this.updateCursor(); this.tipEl.style.display = 'none'; return; }

    for (const el of this.slotViews) {
      const area = el.dataset.area;
      const index = parseInt(el.dataset.index, 10);
      // 面板底部那条热键栏也要标出手持格，否则开着背包根本看不出手里拿的是哪格
      if (area === 'inv') el.classList.toggle('sel', index === g.inventory.selected);
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
    this.updateTip();
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
