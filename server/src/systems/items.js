// Inventory items (Master Key, Flashlight, Code Shuffle) + ground pickups (items and hoods).
// All effects are validated on the server.
import { HOOD_DURATION, HOOD_HIDDEN_DIGITS, INVENTORY_SLOTS, PICKUP_RADIUS } from '../../../shared/constants.js';
import { dist2D } from '../../../shared/geometry.js';
import { ITEMS, rollItem } from '../../../shared/items.js';
import { nearestDoor } from '../../../shared/world.js';

const r2 = (v) => Math.round(v * 100) / 100;

function shuffledIdx(n, k) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

export const itemSystem = {
  freeSpots() {
    const g = this.game;
    return g.map.itemSpots.filter((s) =>
      !g.pickups.some((p) => p.level === (s.level ?? 0) && dist2D(p.x, p.z, s.x, s.z) < 3) &&
      ![...this.players.values()].some((q) => q.alive && q.level === (s.level ?? 0) && dist2D(q.x, q.z, s.x, s.z) < 4));
  },

  spawnPickupAt(type, item, now, spot = null) {
    const g = this.game;
    let s = spot;
    if (!s) {
      const free = this.freeSpots();
      if (!free.length) return null;
      s = free[Math.floor(Math.random() * free.length)];
    }
    const pk = { id: g.nextPickupId++, type, x: r2(s.x), z: r2(s.z), level: s.level ?? 0 };
    if (item) pk.item = item;
    g.pickups.push(pk);
    return pk;
  },

  spawnItem(now) {
    return this.spawnPickupAt('item', rollItem(), now);
  },

  collectPickups(p, now) {
    const g = this.game;
    if (p.inLocker !== null || p.vent || p.watching) return;
    for (let i = 0; i < g.pickups.length; i++) {
      const pk = g.pickups[i];
      if (pk.level !== p.level || dist2D(p.x, p.z, pk.x, pk.z) > PICKUP_RADIUS) continue;
      if (pk.type === 'item') {
        if (now < p.noPickupUntil && pk.droppedBy === p.id) continue;
        const slot = p.inv.indexOf(null);
        if (slot < 0) {
          if (!p.isBot && now - p.fullMsgAt > 3000) {
            p.fullMsgAt = now;
            this.send(p.id, 'item:full', { item: pk.item });
          }
          continue;
        }
        g.pickups.splice(i, 1);
        p.inv[slot] = pk.item;
        this.send(p.id, 'item:got', { item: pk.item, slot });
        this.broadcast('fx:pickup', { type: 'item', item: pk.item, x: pk.x, z: pk.z, level: pk.level, by: p.id });
        return;
      }
      g.pickups.splice(i, 1);
      this.collectPickup(p, pk, now);
      return;
    }
  },

  /** Hood pickup: masks 2 digits for a while. */
  collectPickup(p, pk, now) {
    const g = this.game;
    g.nextSpawn.hood = Math.max(g.nextSpawn.hood, now + 20000 + Math.random() * 15000);
    if (pk.type === 'hood') {
      p.hoodUntil = now + HOOD_DURATION;
      p.hoodDigits = shuffledIdx(4, HOOD_HIDDEN_DIGITS);
      this.send(p.id, 'you:hood', { ms: HOOD_DURATION });
    }
    this.broadcast('fx:pickup', { type: pk.type, x: pk.x, z: pk.z, level: pk.level ?? p.level, by: p.id });
  },

  /** Give an item: into a free slot, or dropped at your feet if full. */
  giveItem(p, item, now) {
    if (!ITEMS[item]) return -1;
    const slot = p.inv.indexOf(null);
    if (slot >= 0) {
      p.inv[slot] = item;
      this.send(p.id, 'item:got', { item, slot });
      return slot;
    }
    this.spawnPickupAt('item', item, now, { x: p.x, z: p.z, level: p.level });
    return -1;
  },

  dropItem(id, slot, now = Date.now()) {
    const p = this.players.get(id);
    if (!p || !p.alive || !this.game || !(slot === 0 || slot === 1)) return { ok: false };
    const item = p.inv[slot];
    if (!item) return { ok: false };
    p.inv[slot] = null;
    if (item === 'flashlight') p.flashlightOn = false;
    const pk = this.spawnPickupAt('item', item, now, { x: p.x + p.lookX * 0.8, z: p.z + p.lookZ * 0.8, level: p.level });
    if (pk) {
      pk.dropped = true;
      pk.droppedBy = p.id;
    }
    p.noPickupUntil = now + 1500;
    return { ok: true, item };
  },

  dropAllItems(p, now) {
    if (!p.inv) return;
    for (let s = 0; s < INVENTORY_SLOTS; s++) {
      const item = p.inv[s];
      if (!item) continue;
      p.inv[s] = null;
      const pk = this.spawnPickupAt('item', item, now, { x: p.x + (s ? 0.6 : -0.6), z: p.z, level: p.level });
      if (pk) pk.dropped = true;
    }
  },

  useItem(id, slot, now = Date.now()) {
    const p = this.players.get(id);
    const g = this.game;
    if (!p || !g || this.phase !== 'playing' || !p.alive) return { ok: false, msg: 'Not now' };
    if (!(slot === 0 || slot === 1)) return { ok: false, msg: 'Bad slot' };
    const item = p.inv[slot];
    if (!item) return this.itemReply(p, { ok: false, msg: 'Empty slot' });
    if (p.vent || p.watching) return this.itemReply(p, { ok: false, item, msg: "Can't use items here" });
    const res = this.applyItem(p, item, now);
    if (res.ok && res.consumed !== false) {
      p.inv[slot] = null;
      p.itemsUsed = (p.itemsUsed || 0) + 1;
    }
    return this.itemReply(p, { item, ...res });
  },

  itemReply(p, res) {
    this.send(p.id, 'item:result', res);
    return res;
  },

  applyItem(p, item, now) {
    const g = this.game;
    switch (item) {
      case 'flashlight':
        p.flashlightOn = !p.flashlightOn;
        return { ok: true, consumed: false, msg: p.flashlightOn ? 'Flashlight on' : 'Flashlight off', on: p.flashlightOn };
      case 'shuffle':
        this.shuffleCode(p, now);
        return { ok: true, msg: 'New code — nobody knows it now' };
      case 'masterkey': {
        let target = null;
        let bd = 2.4;
        for (const d of g.map.doors) {
          if (d.level !== p.level || g.doorStr[d.id] !== '2') continue;
          const dd = dist2D(p.x, p.z, (d.minX + d.maxX) / 2, (d.minZ + d.maxZ) / 2);
          if (dd < bd) {
            bd = dd;
            target = d;
          }
        }
        if (!target) {
          const near = nearestDoor(g.map, p.x, p.z, p.level, 2.4);
          return { ok: false, consumed: false, msg: near ? 'That door is not sealed' : 'Stand next to a red-lit sealed door' };
        }
        this.unlockDoor(target);
        return { ok: true, msg: 'Sealed door opened — it stays open this round' };
      }
      default:
        return { ok: false, consumed: false, msg: 'Unknown item' };
    }
  },
};
