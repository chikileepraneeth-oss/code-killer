// CODE KILLER uses one fixed, hand-designed map (see village.js). This module keeps the old entry point.
import { buildVillage, THEME_INFO } from './village.js';

export { THEME_INFO };

/** The village map. Identical for every game; player count only changes the zone (see room.js). */
export function generateMap() {
  return buildVillage();
}
