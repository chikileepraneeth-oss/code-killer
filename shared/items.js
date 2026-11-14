// Inventory item catalogue (shared so the client can show names / icons / descriptions).

export const ITEMS = {
  masterkey: { name: 'Master Key', rarity: 'common', color: '#e8c15e', icon: '🗝️', desc: 'Opens one of the red-lit sealed doors. It stays open for the rest of the round.' },
  flashlight: { name: 'Flashlight', rarity: 'common', color: '#fff3b0', icon: '🔦', desc: 'Toggle. Read codes in dark rooms and during Lights Out — but your beam gives you away.', toggle: true },
  shuffle: { name: 'Code Shuffle', rarity: 'rare', color: '#ff5ec4', icon: '🔀', desc: 'Use it to get a brand-new secret code. Anyone who memorised yours is now wrong.' },
};

export const ITEM_IDS = Object.keys(ITEMS);
export const RARITY_WEIGHT = { common: 60, rare: 30 };
export const RARITY_COLOR = { common: '#b8c0cc', rare: '#3ec7ff' };

/** Weighted random item id; `rand` is a 0..1 function. */
export function rollItem(rand = Math.random) {
  let total = 0;
  for (const id of ITEM_IDS) total += RARITY_WEIGHT[ITEMS[id].rarity];
  let r = rand() * total;
  for (const id of ITEM_IDS) {
    r -= RARITY_WEIGHT[ITEMS[id].rarity];
    if (r <= 0) return id;
  }
  return ITEM_IDS[ITEM_IDS.length - 1];
}
