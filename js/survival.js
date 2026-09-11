export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const AIR_MAX = 15;
export const SPRINT_MIN_HUNGER = 7;

const EXHAUSTION_MAX = 4;
const FALL_SAFE = 3;
const REGEN_INTERVAL = 4;
const STARVE_INTERVAL = 4;
const STARVE_MIN_HEALTH = 1;
const DROWN_INTERVAL = 1;
const DROWN_DAMAGE = 2;
const REGEN_MIN_HUNGER = 18;
const REGEN_COST = 6;

export const EXHAUST = {
  walk: 0.01,
  sprint: 0.1,
  sneak: 0.005,
  swim: 0.015,
  jump: 0.05,
  sprintJump: 0.2,
  mine: 0.005,
  hurt: 0.1,
  attack: 0.1
};

export class Survival {
  constructor() {
    this.reset();
  }

  reset() {
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.airSupply = AIR_MAX;
    this.regenTimer = 0;
    this.starveTimer = 0;
    this.drownTimer = 0;
    this.armorPoints = 0;
    this.toughness = 0;
    this.dead = false;
  }

  addExhaustion(amount) {
    this.exhaustion += amount;
    while (this.exhaustion >= EXHAUSTION_MAX) {
      this.exhaustion -= EXHAUSTION_MAX;
      if (this.saturation >= 1) this.saturation -= 1;
      else this.hunger = Math.max(0, this.hunger - 1);
    }
  }

  canSprint() {
    return this.hunger >= SPRINT_MIN_HUNGER;
  }

  takeDamage(amount) {
    if (this.dead || amount <= 0) return;
    this.health = Math.max(0, this.health - this.reduceDamage(amount));
    this.addExhaustion(EXHAUST.hurt);
    if (this.health <= 0) this.dead = true;
  }

  reduceDamage(damage) {
    if (this.armorPoints <= 0) return damage;
    const k = Math.max(this.armorPoints / 5, this.armorPoints - damage / (2 + this.toughness / 4));
    return damage * (1 - Math.min(20, k) / 25);
  }

  setArmor(points, toughness) {
    this.armorPoints = points;
    this.toughness = toughness;
  }

  heal(amount) {
    this.health = Math.min(MAX_HEALTH, this.health + amount);
  }

  eat(food) {
    if (!food || this.hunger >= MAX_HUNGER) return false;
    this.hunger = Math.min(MAX_HUNGER, this.hunger + food.hunger);
    this.saturation = Math.min(this.hunger, this.saturation + food.saturation);
    return true;
  }

  update(dt, act) {
    if (this.dead) return;

    if (act.distance > 0) {
      const rate = act.sprinting ? EXHAUST.sprint
        : act.swimming ? EXHAUST.swim
          : act.sneaking ? EXHAUST.sneak
            : EXHAUST.walk;
      this.addExhaustion(rate * act.distance);
    }
    if (act.sprintJumped) this.addExhaustion(EXHAUST.sprintJump);
    else if (act.jumped) this.addExhaustion(EXHAUST.jump);

    if (act.headInWater) {
      this.airSupply = Math.max(0, this.airSupply - dt);
      if (this.airSupply <= 0) {
        this.drownTimer += dt;
        while (this.drownTimer >= DROWN_INTERVAL) {
          this.drownTimer -= DROWN_INTERVAL;
          this.takeDamage(DROWN_DAMAGE);
          if (this.dead) return;
        }
      }
    } else {
      this.airSupply = Math.min(AIR_MAX, this.airSupply + dt * 4);
      this.drownTimer = 0;
    }

    if (act.landedFall > FALL_SAFE) {
      this.takeDamage(Math.ceil(act.landedFall - FALL_SAFE));
      if (this.dead) return;
    }

    if (this.hunger >= REGEN_MIN_HUNGER && this.health < MAX_HEALTH) {
      this.regenTimer += dt;
      while (this.regenTimer >= REGEN_INTERVAL) {
        this.regenTimer -= REGEN_INTERVAL;
        this.heal(1);
        this.addExhaustion(REGEN_COST);
      }
    } else {
      this.regenTimer = 0;
    }

    if (this.hunger <= 0 && this.health > STARVE_MIN_HEALTH) {
      this.starveTimer += dt;
      while (this.starveTimer >= STARVE_INTERVAL) {
        this.starveTimer -= STARVE_INTERVAL;
        this.health = Math.max(STARVE_MIN_HEALTH, this.health - 1);
        if (this.health <= 0) { this.dead = true; return; }
      }
    } else {
      this.starveTimer = 0;
    }
  }
}
