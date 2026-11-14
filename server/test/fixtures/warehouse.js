// Test-only fixture: the original hand-made warehouse map (60x60) in the current map format.
// Gameplay tests use its fixed coordinates (open line along z = -8, pillar at the origin, dark room).
import { Builder, emptyMap, splitRange } from '../../../shared/mapkit.js';
import { prepareMap } from '../../../shared/world.js';

export function warehouseMap() {
  return prepareMap(classicWarehouse(1, 2, 'clear'));
}

function classicWarehouse(seed, playerCount, weather) {
  const M = emptyMap();
  Object.assign(M, { id: 'classic', seed, theme: 'classic', themeName: 'Classic Warehouse', sizeClass: 'medium', size: 60, playerCount, weather: weather === 'auto' ? 'clear' : weather });
  const b = new Builder(M);
  const box = (x0, z0, x1, z1, h, kind = 'wall') => b.box(x0, z0, x1, z1, h, kind);
  const wall = (x0, z0, x1, z1, h = 3.5, t = 0.5) => (z0 === z1 ? box(x0, z0 - t / 2, x1, z0 + t / 2, h) : box(x0 - t / 2, z0, x0 + t / 2, z1, h));
  const room = (x0, z0, x1, z1, doors = {}) => {
    for (const [a, c] of splitRange(x0, x1, doors.n)) wall(a, z0, c, z0);
    for (const [a, c] of splitRange(x0, x1, doors.s)) wall(a, z1, c, z1);
    for (const [a, c] of splitRange(z0, z1, doors.w)) wall(x0, a, x0, c);
    for (const [a, c] of splitRange(z0, z1, doors.e)) wall(x1, a, x1, c);
  };
  const crate = (x, z, s = 1.2, h = s) => box(x - s / 2, z - s / 2, x + s / 2, z + s / 2, h, h >= 1.6 ? 'stack' : 'crate');
  box(-30, -30, 30, -29, 4, 'perimeter');
  box(-30, 29, 30, 30, 4, 'perimeter');
  box(-30, -30, -29, 30, 4, 'perimeter');
  box(29, -30, 30, 30, 4, 'perimeter');
  room(-27, -27, -13, -15, { s: [[-21, -18.5]], e: [[-22.5, -20]] });
  crate(-24.5, -24.5, 1.4); crate(-16, -25, 1.4, 2.6); crate(-24, -18, 1.2); crate(-17, -18.5, 1.2); crate(-20.5, -24.8, 1.0);
  room(13, -27, 26, -16, { s: [[18, 20.5]] });
  crate(16, -24, 1.2); crate(22.5, -19.5, 1.2); crate(22.5, -25, 1.0, 2.0);
  room(-27, 14, -14, 27, { n: [[-22, -19.5]], e: [[19, 21.5]] });
  box(-22.5, 19.6, -17.5, 20.4, 0.6, 'bench');
  wall(6, 12, 22, 12); wall(10, 16.5, 27, 16.5); wall(6, 21, 22, 21); wall(10, 25.5, 27, 25.5); wall(6, 21, 6, 25.5);
  box(-1, -1, 1, 1, 5, 'pillar');
  wall(-7, -4, -7, 3, 2.6); wall(-7, -5, -3, -5, 2.6); wall(7, -3, 7, 4, 2.6); wall(3, 5, 7, 5, 2.6);
  crate(-3.5, 3.5, 1.0); crate(4, -3, 1.0);
  crate(-4, -24, 2, 2.6); crate(4, -20, 1.4); crate(-8, -18, 1.2); wall(-6, -12, 6, -12, 2.6);
  crate(-12, -8, 1.4, 2.6); wall(-11, 0, -11, 8, 3); crate(-27, -11, 1.2);
  crate(24, -11, 1.2); crate(17, 0, 1.4, 2.6); wall(12, 8.5, 20, 8.5, 3);
  crate(2, 16, 1.2); crate(-3, 13, 1.4, 2.6); crate(-10, 26, 1.2);
  const F = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
  const lockers = [
    [-26.35, 16, 'e'], [-26.35, 17.2, 'e'], [-26.35, 18.4, 'e'], [-26.35, 22, 'e'], [-26.35, 23.2, 'e'], [-26.35, 24.4, 'e'],
    [-24, 26.4, 'n'], [-22.8, 26.4, 'n'], [-17.5, 26.4, 'n'], [-16.3, 26.4, 'n'],
    [0, 1.4, 's'], [28.6, 19, 'w'], [-26.4, -21, 'e'], [25.4, -22.5, 'w'],
  ];
  for (const [x, z, f] of lockers) b.locker(x, z, F[f][0], F[f][1], 0, 'locker');
  const bushes = [
    [-24, -8, 1.6], [-18, -4, 1.5], [-25, 3, 1.6], [-16, 7, 1.5], [-21, 10.5, 1.4],
    [15, -9, 1.6], [21, -6, 1.5], [26, 0, 1.6], [13, 4, 1.5], [21, 4.5, 1.5],
    [-6, 20, 1.5], [0, 24, 1.6], [-9, 14, 1.4], [10, -16, 1.4], [-10, -22, 1.5],
  ];
  for (const [x, z, r] of bushes) b.bush(x, z, r);
  M.rooms.push({ id: 0, minX: 13.25, maxX: 25.75, minZ: -26.75, maxZ: -16.25, level: 0, houseId: -1, kind: 'blackout', lightOn: false, alwaysDark: true });
  M.houses.push({ id: 0, minX: 13, maxX: 26, minZ: -27, maxZ: -16, hasUpper: false, hasBasement: false, kind: 'blackout', roofY: 3.5 });
  const spawns = [[-20, -10], [-24, 0], [-18, 8], [-9, -3], [-4, -8], [3, -7], [10, -5], [18, -3], [24, 5], [16, -12], [-4, 17], [3, 21], [-8, 23], [10, 3], [0, -16], [-2, 8]];
  M.spawns = spawns.map(([x, z]) => ({ x, z }));
  M.itemSpots = [[-20, -21], [19.5, -21], [-20, 23], [16, 14.2], [16, 23.2], [0, -8], [-22, -3], [24, -4], [-6, 9], [5, 27], [-1, -20], [27, 10]].map(([x, z]) => ({ x, z, level: 0 }));
  for (const [x, z] of [[-10, -10], [10, -10], [-10, 10], [10, 10], [0, -26], [-27, 0], [27, -3], [0, 27]]) b.lamp(x, z, 0, 'lantern', 4);
  for (const [x, z, r] of [[5, -8, 0.9], [-14, 2, 0.8], [12, 20, 1.0]]) b.puddle(x, z, r);
  M.emergencyLights.push({ x: 0, z: 3, level: 0 }, { x: 19, z: -15, level: 0 });
  M.itemCount = 5;
  M.lightsOuts = 2;
  return M;
}
