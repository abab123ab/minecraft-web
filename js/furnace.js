import { ITEMS } from './items.js';
import { smeltRecipe } from './crafting.js';
import { makeStack, maxStack } from './inventory.js';

export function makeFurnace() {
  return { input: null, fuel: null, out: null, burn: 0, burnMax: 0, prog: 0, progMax: 1 };
}

export function tickFurnaces(game, dt) {
  for (const f of game.furnaces.values()) {
    const rec = f.input ? smeltRecipe(f.input.id) : null;
    const canOutput = rec && (!f.out || (f.out.id === rec.output && f.out.count < maxStack(rec.output)));
    if (rec && canOutput) {
      if (f.burn <= 0 && f.fuel) {
        const fuelVal = ITEMS[f.fuel.id].fuel || 0;
        if (fuelVal > 0) {
          f.burn = fuelVal;
          f.burnMax = fuelVal;
          f.fuel.count--;
          if (f.fuel.count <= 0) f.fuel = null;
        }
      }
      if (f.burn > 0) {
        f.burn -= dt;
        f.progMax = rec.time;
        f.prog += dt;
        if (f.prog >= rec.time) {
          f.prog = 0;
          f.input.count--;
          if (f.input.count <= 0) f.input = null;
          if (f.out) f.out.count++;
          else f.out = makeStack(rec.output, 1);
          game.sfx.furnaceReady();
        }
      } else {
        f.prog = 0;
      }
    } else {
      f.prog = 0;
      if (f.burn > 0) f.burn = Math.max(0, f.burn - dt);
    }
    if (f.burn <= 0) f.burnMax = 0;
  }
  if (game.ui.isOpen() && game.ui.mode === 'furnace') game.ui.render();
}
