import assert from 'node:assert/strict';
import test from 'node:test';
import { EYE_HEIGHT, LEVEL_HEIGHT, PLAYER_RADIUS, zoneStartRadius } from '../../shared/constants.js';
import { collides, dist2D, pointInBox } from '../../shared/geometry.js';
import { generateMap } from '../../shared/mapgen.js';
import { floorHeight, hasFloor, levelGeo, prepareMap } from '../../shared/world.js';
import { findPath } from '../src/nav.js';
import { Room } from '../src/room.js';
import { makeTransport, walk } from './helpers.js';

const map = prepareMap(generateMap());
const H = LEVEL_HEIGHT;
const inHouse = (h, x, z) => pointInBox(x, z, h);
const housesOf = (type) => map.houses.filter((h) => h.type === type);
const roomsOf = (h, level) => map.rooms.filter((r) => r.houseId === h.id && r.level === level && r.kind !== 'hall');
const hideSpotsIn = (h) => map.hideZones.filter((z) => inHouse(h, (z.minX + z.maxX) / 2, (z.minZ + z.maxZ) / 2)).length + map.lockers.filter((l) => inHouse(h, l.x, l.z)).length;

test('one fixed map: identical every game', () => {
  assert.equal(JSON.stringify(generateMap()), JSON.stringify(generateMap()));
  assert.equal(map.size, 72);
});

test('small house: 1 floor, 2-3 rooms, a wardrobe and a bed', () => {
  const hs = housesOf('small');
  assert.ok(hs.length >= 2);
  for (const h of hs) {
    assert.equal(h.hasUpper, false);
    const rooms = roomsOf(h, 0).length;
    assert.ok(rooms >= 2 && rooms <= 3, `${rooms} rooms`);
    assert.ok(map.lockers.some((l) => l.kind === 'wardrobe' && inHouse(h, l.x, l.z)));
    assert.ok(map.hideZones.some((z) => z.kind === 'bed' && inHouse(h, z.minX, z.minZ)));
  }
});

test('family house: 2 floors, 4-5 rooms, a staircase, a bathroom with a mirror', () => {
  const hs = housesOf('family');
  assert.ok(hs.length >= 2);
  for (const h of hs) {
    assert.equal(h.hasUpper, true);
    const rooms = roomsOf(h, 0).length + roomsOf(h, 1).length;
    assert.ok(rooms >= 4 && rooms <= 5, `${rooms} rooms`);
    assert.ok(map.stairs.some((s) => s.to === 1 && inHouse(h, s.minX, s.minZ)));
    const bath = map.rooms.find((r) => r.houseId === h.id && r.kind === 'bath');
    assert.ok(bath);
    assert.ok(map.mirrors.some((m) => m.level === bath.level && pointInBox(m.x, m.z, bath, 0.2)), 'mirror in the bathroom');
  }
});

test('big house: 2 floors + dark basement, 6+ rooms, a vent connection', () => {
  const hs = housesOf('big');
  assert.ok(hs.length >= 2);
  for (const h of hs) {
    assert.equal(h.hasUpper, true);
    assert.equal(h.hasBasement, true);
    const rooms = roomsOf(h, 0).length + roomsOf(h, 1).length + roomsOf(h, -1).length;
    assert.ok(rooms >= 6, `${rooms} rooms`);
    assert.ok(map.rooms.filter((r) => r.houseId === h.id && r.level === -1).every((r) => r.alwaysDark));
    const vent = map.vents.find((v) => inHouse(h, v.x, v.z));
    assert.ok(vent, 'has a vent');
    assert.ok(map.ducts.some((d) => d.a === vent.id || d.b === vent.id), 'vent is connected');
  }
});

test('every house: windows, switches snapped to walls, 2+ hiding spots, 2+ open exits', () => {
  for (const h of map.houses.filter((x) => x.kind !== 'shed')) {
    assert.ok(map.windows.some((w) => inHouse(h, w.minX, w.minZ) || pointInBox(w.minX, w.minZ, h, 0.3)), `${h.type} has windows`);
    assert.ok(hideSpotsIn(h) >= 2, `${h.type} #${h.id} hiding spots`);
    const exits = map.doors.filter((d) => d.level === 0 && d.houseId === h.id && !d.special &&
      (Math.abs(d.minX - h.minX) < 0.3 || Math.abs(d.maxX - h.maxX) < 0.3 || Math.abs(d.minZ - h.minZ) < 0.3 || Math.abs(d.maxZ - h.maxZ) < 0.3));
    assert.ok(exits.length >= 2, `${h.type} #${h.id} has ${exits.length} exits`);
  }
  for (const sw of map.switches) {
    let best = Infinity;
    for (const b of map.boxes) {
      if (b.kind !== 'wall' || b.level !== sw.level) continue;
      best = Math.min(best, dist2D(sw.x, sw.z, Math.max(b.minX, Math.min(sw.x, b.maxX)), Math.max(b.minZ, Math.min(sw.z, b.maxZ))));
    }
    assert.ok(best < 0.3, `switch ${sw.id} is ${best.toFixed(2)} from a wall`);
  }
});

test('map features: square, park, alley, shop, security room, 4-6 sealed doors', () => {
  assert.ok(map.boxes.some((b) => b.kind === 'fountain' && Math.hypot(b.minX, b.minZ) < 3), 'square fountain');
  assert.ok(map.bushes.length >= 15, 'park/garden bushes');
  assert.ok(map.houses.some((h) => h.type === 'shop'));
  assert.ok(map.security && map.security.cameras.length === 4);
  const sealed = map.doors.filter((d) => d.special);
  assert.ok(sealed.length >= 4 && sealed.length <= 6, `${sealed.length} sealed doors`);
  assert.ok(sealed.some((d) => d.note === 'alley shortcut'));
});

test('UPSTAIRS IS REACHABLE: walk up and back down every staircase; the eye never pokes through a ceiling', () => {
  const t = makeTransport();
  const room = new Room('WALKAA', t);
  room.addPlayer({ id: 'w', name: 'Walker' });
  room.addPlayer({ id: 'x', name: 'Other' });
  room.updateSettings('w', { graceSeconds: 0, lightsOut: false });
  room.start('w', 1e7);
  room.game.nextBountyAt = Infinity;
  const p = room.players.get('w');
  const holeAt = (x, z, level) => map.stairs.some((s) => (s.from === level || s.to === level) && pointInBox(x, z, s, 0.15));
  const ceilingOk = (q) => {
    const eye = floorHeight(map, q.x, q.z, q.level) + EYE_HEIGHT;
    const roof = q.level * H + H - 0.25;
    const indoors = map.houses.some((h) => pointInBox(q.x, q.z, h));
    return !indoors || eye < roof || holeAt(q.x, q.z, q.level) || holeAt(q.x, q.z, q.level + 1);
  };
  let now = 1e7;
  const twoFloor = map.stairs.filter((s) => s.to === 1);
  assert.ok(twoFloor.length >= 4, 'stairs in every 2-floor house');
  for (const s of map.stairs) {
    Object.assign(p, { x: s.a.x, z: s.a.z, level: s.from, budget: 0, budgetAt: now, inLocker: null });
    let r = walk(room, 'w', [[s.a.x, s.a.z], [s.b.x, s.b.z]], now);
    assert.equal(p.level, s.to, `stairs ${s.id}: reached level ${s.to} (at ${p.x.toFixed(2)},${p.z.toFixed(2)} L${p.level})`);
    assert.ok(dist2D(p.x, p.z, s.b.x, s.b.z) < 0.25, `stairs ${s.id}: stepped off at the top`);
    for (const q of r.trace) assert.ok(ceilingOk(q), `stairs ${s.id}: eye through the ceiling at ${q.x},${q.z}`);
    r = walk(room, 'w', [[s.b.x, s.b.z], [s.a.x, s.a.z]], r.now + 100);
    assert.equal(p.level, s.from, `stairs ${s.id}: back down`);
    assert.ok(dist2D(p.x, p.z, s.a.x, s.a.z) < 0.25);
    for (const q of r.trace) assert.ok(ceilingOk(q));
    now = r.now + 1000;
  }
});

test('everything outside the sealed rooms is reachable from every spawn', () => {
  const sealedRooms = map.doors.filter((d) => d.special).length;
  assert.ok(sealedRooms > 0);
  const targets = [
    ...map.spawns.map((s) => ({ ...s, level: 0 })),
    ...map.stairs.flatMap((s) => [s.a, s.b]),
    ...map.vents,
    { ...map.security.monitor, level: 0 },
  ];
  const s0 = { ...map.spawns[0], level: 0 };
  for (const t of targets) assert.ok(findPath(map, s0, t), `unreachable ${t.x},${t.z} L${t.level}`);
  let reachableItems = 0;
  for (const it of map.itemSpots) if (findPath(map, s0, it)) reachableItems++;
  assert.ok(reachableItems >= map.itemSpots.length - 6, 'only items behind sealed doors need a key');
});

test('fixed spawn and item points, spread out and clear of geometry', () => {
  const geo = levelGeo(map, 0, map.doors.map(() => '1').join(''));
  assert.equal(map.spawns.length, 16);
  let minD = Infinity;
  for (const s of map.spawns) {
    assert.ok(!collides(geo, s.x, s.z, PLAYER_RADIUS + 0.1));
    for (const o of map.spawns) if (o !== s) minD = Math.min(minD, dist2D(s.x, s.z, o.x, o.z));
  }
  assert.ok(minD >= 8, `closest spawns ${minD}`);
  assert.ok(map.itemSpots.length >= 20);
  for (const it of map.itemSpots) assert.ok(!collides(levelGeo(map, it.level, map.doors.map(() => '1').join('')), it.x, it.z, 0.4));
});

test('small games keep the map but start with a smaller zone (and spawns inside it)', () => {
  const mk = (n) => {
    const room = new Room('ZONEAA', makeTransport());
    room.addPlayer({ id: 'h', name: 'H' });
    room.updateSettings('h', { maxPlayers: 16 });
    for (let i = 1; i < n; i++) room.addBot('h');
    room.start('h', 1e7);
    return room;
  };
  const small = mk(3);
  assert.equal(small.game.zone.r, zoneStartRadius(3));
  for (const p of small.players.values()) assert.ok(Math.hypot(p.x, p.z) < small.game.zone.r - 2, 'spawned inside the zone');
  const big = mk(12);
  assert.equal(big.game.zone.r, zoneStartRadius(12));
  assert.ok(big.game.zone.r > small.game.zone.r * 1.8);
  assert.equal(small.game.map.size, big.game.map.size, 'same map');
});

// ------------------------------------------------------------------ stairwell openings
const holeOf = (s) => ({ level: Math.max(s.from, s.to), minX: s.minX, maxX: s.maxX, minZ: s.minZ, maxZ: s.maxZ });
const overlaps = (a, b, eps = 1e-6) => a.minX < b.maxX - eps && a.maxX > b.minX + eps && a.minZ < b.maxZ - eps && a.maxZ > b.minZ + eps;

test('stairwell openings: no floor, no collider and nothing else covers the hole above every staircase', () => {
  for (const s of map.stairs) {
    const hole = holeOf(s);
    // the floor slab of that level is built from pieces around the opening
    assert.equal(map.floors.filter((f) => f.level === hole.level && overlaps(f, hole)).length, 0, `stairs ${s.id}: a floor piece covers the opening`);
    assert.ok(map.floors.some((f) => f.level === hole.level && f.houseId === map.floors.find((g) => overlaps(g, { ...hole, minX: hole.minX - 1, maxX: hole.maxX + 1 }))?.houseId), 'the rest of the floor is still there');
    for (let x = s.minX + 0.05; x < s.maxX - 0.03; x += 0.2) {
      for (let z = s.minZ + 0.05; z < s.maxZ - 0.03; z += 0.2) assert.equal(hasFloor(map, x, z, hole.level), false, `stairs ${s.id}: floor at ${x.toFixed(2)},${z.toFixed(2)}`);
    }
    // no solid / sight box on that level inside the opening (rails sit just outside it)
    const inner = { minX: s.minX + 0.02, maxX: s.maxX - 0.02, minZ: s.minZ + 0.02, maxZ: s.maxZ - 0.02 };
    const blockers = map.static[hole.level].solids.filter((b) => overlaps(b, inner));
    assert.deepEqual(blockers.map((b) => b.kind), [], `stairs ${s.id}: collider over the opening`);
    // nothing placed in mid-air / on top of the hole
    assert.ok(!map.lamps.some((l) => l.kind === 'ceiling' && l.level === hole.level - 1 && pointInBox(l.x, l.z, s, 0.2)), 'no ceiling lamp hanging in the opening');
    assert.ok(!map.itemSpots.some((it) => it.level === hole.level && pointInBox(it.x, it.z, s, 0.3)), 'no item spot in the opening');
    assert.ok(!map.hideZones.some((hz) => hz.level === hole.level && overlaps(hz, s)), 'no hiding zone in the opening');
    // railing on the 3 open sides upstairs, the entry side (towards b) left open
    const rails = map.boxes.filter((b) => b.kind === 'stairrail' && b.level === hole.level && overlaps(b, { minX: s.minX - 0.3, maxX: s.maxX + 0.3, minZ: s.minZ - 0.3, maxZ: s.maxZ + 0.3 }));
    assert.equal(rails.length, 3, `stairs ${s.id}: 3 rails around the opening`);
    for (const r of rails) assert.ok(!pointInBox(s.b.x, s.b.z, r, 0.3), 'stair entry upstairs is open');
    // head clearance: the opening is the full ramp length and wider than a player
    assert.ok(s.len >= 3.6 && s.width >= 2 * PLAYER_RADIUS + 0.45, `stairs ${s.id}: ${s.width} m wide`);
  }
});

test('a player can step from the upstairs landing into the opening and walk down through it', () => {
  const room = new Room('DESCAA', makeTransport());
  room.addPlayer({ id: 'w', name: 'Walker' });
  room.addPlayer({ id: 'x', name: 'Other' });
  room.updateSettings('w', { graceSeconds: 0, lightsOut: false });
  room.start('w', 1e7);
  room.game.nextBountyAt = Infinity;
  const p = room.players.get('w');
  let now = 1e7;
  for (const s of map.stairs) {
    const top = Math.max(s.from, s.to);
    const upper = s.to === top ? s.b : s.a; // the end of the ramp on the upper level
    const lower = s.to === top ? s.a : s.b;
    const start = upper; // on the landing, 0.6 m before the edge of the opening
    assert.ok(!pointInBox(start.x, start.z, s), 'starts outside the opening');
    Object.assign(p, { x: start.x, z: start.z, level: top, budget: 0, budgetAt: now, inLocker: null });
    assert.equal(hasFloor(map, start.x, start.z, top), true, 'landing has floor');
    const r = walk(room, 'w', [[lower.x, lower.z]], now);
    const below = r.trace.filter((q) => pointInBox(q.x, q.z, s, -0.05) && floorHeight(map, q.x, q.z, q.level) < top * H - 0.5);
    assert.ok(below.length > 3, `stairs ${s.id}: went down through the opening`);
    assert.equal(p.level, top - 1, `stairs ${s.id}: arrived on the floor below`);
    assert.ok(dist2D(p.x, p.z, lower.x, lower.z) < 0.3, `stairs ${s.id}: at the bottom of the stairs`);
    now = r.now + 1000;
  }
});

test('bots walk ground floor -> upstairs -> back down in every 2-floor house', () => {
  const room = new Room('BOTSTA', makeTransport());
  room.addPlayer({ id: 'h', name: 'Human' });
  room.addBot('h');
  room.updateSettings('h', { graceSeconds: 120, lightsOut: false });
  room.start('h', 1e7);
  room.game.nextBountyAt = Infinity;
  const bot = [...room.players.values()].find((q) => q.isBot);
  Object.assign(room.players.get('h'), { x: -33, z: 33, level: 0 }); // far away: nothing to chase
  let now = 1e7;
  const runTo = (goal, maxTicks = 900) => {
    Object.assign(bot.ai, { mode: 'zone', goal, path: null, nextRepath: now, stairPhase: null, attack: null });
    for (let i = 0; i < maxTicks; i++) {
      now += 50;
      room.tick(now);
      if (bot.level === goal.level && dist2D(bot.x, bot.z, goal.x, goal.z) < 1.0) return true;
    }
    return false;
  };
  for (const h of map.houses.filter((x) => x.hasUpper)) {
    const up = map.rooms.find((r) => r.houseId === h.id && r.level === 1 && r.kind === 'bedroom');
    const down = map.rooms.find((r) => r.houseId === h.id && r.level === 0 && r.kind === 'kitchen');
    Object.assign(bot, { x: (down.minX + down.maxX) / 2, z: (down.minZ + down.maxZ) / 2, level: 0, inLocker: null });
    const ok1 = runTo({ x: (up.minX + up.maxX) / 2, z: (up.minZ + up.maxZ) / 2, level: 1 });
    assert.ok(ok1, `${h.type} #${h.id}: bot reached the upstairs bedroom (at ${bot.x.toFixed(1)},${bot.z.toFixed(1)} L${bot.level})`);
    const ok2 = runTo({ x: (down.minX + down.maxX) / 2, z: (down.minZ + down.maxZ) / 2, level: 0 });
    assert.ok(ok2, `${h.type} #${h.id}: bot came back down (at ${bot.x.toFixed(1)},${bot.z.toFixed(1)} L${bot.level})`);
  }
});
