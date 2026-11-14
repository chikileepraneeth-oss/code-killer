import { Room } from '../src/room.js';
import { prepareMap } from '../../shared/world.js';
import { Builder, emptyMap } from '../../shared/mapkit.js';
import { warehouseMap } from './fixtures/warehouse.js';

export function makeTransport() {
  const log = [];
  return {
    log,
    send(playerId, event, data) {
      log.push({ playerId, event, data });
    },
    of(playerId, event) {
      return log.filter((m) => m.playerId === playerId && (!event || m.event === event)).map((m) => m.data);
    },
    last(playerId, event) {
      const all = this.of(playerId, event);
      return all[all.length - 1];
    },
    clear() {
      log.length = 0;
    },
  };
}

/** Room with N human players, optionally started. Grace disabled by default for kill tests. */
export function makeRoom(n = 3, { start = true, settings = {}, now = 1_000_000 } = {}) {
  const t = makeTransport();
  const room = new Room('TESTAB', t);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `p${i}`;
    room.addPlayer({ id, name: `Player${i}` }, now);
    ids.push(id);
  }
  room.updateSettings('p0', { graceSeconds: 0, lightsOut: false, ...settings });
  room.mapOverride = warehouseMap();
  if (start) room.start('p0', now);
  return { room, t, ids, now };
}

/** Place players at fixed open positions (centre plaza, open line of sight along x at z = -8). */
export function place(room, id, x, z) {
  const p = room.players.get(id);
  p.x = x;
  p.z = z;
  return p;
}

/**
 * Tiny deterministic arena for environment/item tests (40 x 40):
 *  - House 0 at x[0,10] z[-5,5]: west door (id 0, automatic) at z[-0.6,0.6], sealed east door (id 1),
 *    north window x[4,6], bed hide zone, wardrobe, light switch, a walkable staircase up
 *    (ramp x[1.5,5.5] z[-4.6,-3.5]) and down to a dark basement (ramp x[4.5,8.5] z[3.4,4.5]).
 *  - Two linked vents, a security room with one camera, a mirror, a puddle and a bush outside.
 */
export function arenaMap() {
  const M = emptyMap();
  Object.assign(M, { id: 'arena', theme: 'village', themeName: 'Test Arena', size: 40, weather: 'fog', sizeClass: 'fixed' });
  const b = new Builder(M, { houseId: 0 });
  M.houses.push({ id: 0, type: 'test', kind: 'house', minX: 0, maxX: 10, minZ: -5, maxZ: 5, hasUpper: true, hasBasement: true, roofY: 6.4 });
  b.floor(0, -5, 10, 5, 0, 'house');
  b.floor(0, -5, 10, 5, 1, 'upper');
  b.floor(0, -5, 10, 5, -1, 'basement');
  b.shell(0, -5, 10, 5, 0, {
    w: [{ a: -0.6, b: 0.6, type: 'door' }],
    e: [{ a: -0.6, b: 0.6, type: 'door', special: true }],
    n: [{ a: 4, b: 6, type: 'window' }],
  });
  b.shell(0, -5, 10, 5, 1, {});
  b.shell(0, -5, 10, 5, -1, {});
  const living = b.room(0, -5, 10, 5, 0, 'living');
  b.room(0, -5, 10, 5, -1, 'basement', { alwaysDark: true, lightOn: false });
  b.room(0, -5, 10, 5, 1, 'bedroom');
  M.switches.push({ id: 0, roomId: living.id, x: 0.5, z: 1.2, level: 0 });
  b.stairs(1.5, -4.6, 5.5, -3.5, [1, 0], 0, 1);
  b.stairs(4.5, 3.4, 8.5, 4.5, [1, 0], 0, -1);
  b.bed(6, 0.5, 8, 2.3, 0);
  b.locker(9.4, -2.0, -1, 0, 0, 'wardrobe');
  const w = new Builder(M);
  w.vent(-10, -10, 0);
  w.vent(-10, 10, 0);
  M.ducts.push({ a: 0, b: 1 });
  M.security = { roomId: 0, level: 0, monitor: { x: -15, z: 0 }, chair: { x: -15, z: 0.6, yaw: Math.PI }, cameras: [{ id: 0, name: 'CAM 1', x: 15, z: -15, y: 3, level: 0, yaw: 0, pitch: -0.3 }] };
  M.mirrors.push({ x: -5, z: 15, nx: 0, nz: -1, level: 0, w: 1, y0: 0.9, y1: 2.2 });
  M.puddles.push({ x: 15, z: 15, r: 1 });
  M.bushes.push({ x: 15, z: -15, r: 1.5 });
  M.spawns = [{ x: -15, z: -15 }, { x: -12, z: 12 }, { x: 15, z: 8 }, { x: 12, z: -8 }];
  M.itemSpots = [{ x: -18, z: -5, level: 0 }, { x: 18, z: 5, level: 0 }];
  M.itemCount = 0;
  M.lightsOuts = 1;
  return prepareMap(M);
}

/** Started room on the arena map (no grace, no lights out, no auto spawns). */
export function arenaRoom(n = 3, { settings = {}, now = 2_000_000 } = {}) {
  const t = makeTransport();
  const room = new Room('ARENAA', t);
  for (let i = 0; i < n; i++) room.addPlayer({ id: `p${i}`, name: `Player${i}` }, now);
  room.updateSettings('p0', { graceSeconds: 0, lightsOut: false, ...settings });
  room.mapOverride = arenaMap();
  room.start('p0', now);
  const g = room.game;
  g.nextSpawn = { hood: Infinity, item: Infinity };
  g.nextBountyAt = Infinity;
  g.pickups = [];
  return { room, t, now, g };
}

export function placeAt(room, id, x, z, level = 0, look = null) {
  const p = room.players.get(id);
  Object.assign(p, { x, z, level, budget: 0, budgetAt: room.game ? room.game.lastTick : 0 });
  if (look) {
    p.lookX = look[0];
    p.lookZ = look[1];
  }
  return p;
}

/**
 * Walk a player through waypoints using real movement packets (server validation, collisions, doors,
 * ramps). Returns the trace [{x, z, level}] sampled after every packet.
 */
export function walk(room, id, points, startNow, { speed = 5.0, dt = 50 } = {}) {
  const p = room.players.get(id);
  let now = startNow;
  const trace = [];
  for (const [tx, tz] of points) {
    for (let i = 0; i < 400; i++) {
      const dx = tx - p.x;
      const dz = tz - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.08) break;
      const st = Math.min(d, (speed * dt) / 1000);
      now += dt;
      room.handleMove(id, { x: p.x + (dx / d) * st, z: p.z + (dz / d) * st, yaw: 0 }, now);
      room.updateDoors(now);
      trace.push({ x: p.x, z: p.z, level: p.level });
    }
  }
  return { trace, now };
}
