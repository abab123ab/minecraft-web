const ICON_COUNT = 10;
const BASE = 'textures/hud/';

const HEART = { container: BASE + 'heart_container.png', half: BASE + 'heart_half.png', full: BASE + 'heart_full.png' };
const FOOD = { container: BASE + 'food_empty.png', half: BASE + 'food_half.png', full: BASE + 'food_full.png' };
const ARMOR = { container: BASE + 'armor_empty.png', half: BASE + 'armor_half.png', full: BASE + 'armor_full.png' };

function makeRow(el, icons, flip) {
  el.innerHTML = '';
  const cells = [];
  for (let i = 0; i < ICON_COUNT; i++) {
    const d = document.createElement('div');
    d.className = 'hud-icon' + (flip ? ' flip' : '');
    d.style.backgroundImage = 'url(' + icons.container + ')';
    el.appendChild(d);
    cells.push(d);
  }
  return cells;
}

function paint(cells, icons, value) {
  for (let i = 0; i < ICON_COUNT; i++) {
    const v = value - i * 2;
    const src = v >= 2 ? icons.full : (v === 1 ? icons.half : icons.container);
    const url = 'url(' + src + ')';
    if (cells[i].dataset.src !== src) {
      cells[i].style.backgroundImage = url;
      cells[i].dataset.src = src;
    }
  }
}

export class Hud {
  constructor() {
    this.healthEl = document.getElementById('health-bar');
    this.hungerEl = document.getElementById('hunger-bar');
    this.armorEl = document.getElementById('armor-bar');
    this.hearts = makeRow(this.healthEl, HEART, false);
    this.foods = makeRow(this.hungerEl, FOOD, true);
    this.armors = this.armorEl ? makeRow(this.armorEl, ARMOR, false) : [];
    this.lastHealth = -1;
    this.lastHunger = -1;
    this.lastArmor = -1;
  }

  update(survival) {
    const h = Math.ceil(survival.health);
    const f = Math.ceil(survival.hunger);
    const a = Math.ceil(survival.armorPoints || 0);
    if (h !== this.lastHealth) {
      paint(this.hearts, HEART, survival.health);
      this.lastHealth = h;
    }
    if (f !== this.lastHunger) {
      paint(this.foods, FOOD, survival.hunger);
      this.lastHunger = f;
    }
    if (a !== this.lastArmor) {
      paint(this.armors, ARMOR, survival.armorPoints || 0);
      if (this.armorEl) this.armorEl.style.display = a > 0 ? 'flex' : 'none';
      this.lastArmor = a;
    }
  }
}
