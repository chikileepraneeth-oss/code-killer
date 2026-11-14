// Map runtime helpers shared by server and client: per-level collision with door state,
// rooms & darkness, hiding spots and interactables.
import { DOOR_OPEN_RANGE, INTERACT_RANGE, LEVEL_HEIGHT, LOCKER_RANGE } from './constants.js';
import { buildGrid, dist2D, pointInBox } from './geometry.js';
import { carveStairwells } from './mapkit.js';

/** Door state string: one char per door: '0' closed, '1' open, '2' locked (closed). */
export function defaultDoorState(map) {
  return map.doors.map((d) => (d.special ? '2' : d.open ? '1' : '0')).join('');
}
export function defaultLightState(map) {
  return map.rooms.map((r) => (r.lightOn ? '1' : '0')).join('');
}

export function prepareMap(map) {
  if (map._prepared) return map;
  carveStairwells(map); // also for test fixtures / older map JSON (no-op when already carved)
  const levels = new Set([0]);
  for (const f of map.floors) levels.add(f.level);
  for (const b of map.boxes) levels.add(b.level);
  map.levels = [...levels].sort((a, b) => a - b);
  map.static = {};
  for (const lv of map.levels) {
    const boxes = map.boxes.filter((b) => b.level === lv);
    map.static[lv] = {
      solids: boxes.filter((b) => b.solid !== false),
      sightBlockers: boxes.filter((b) => b.sight),
    };
  }
  map._geoCache = new Map();
  Object.defineProperty(map, '_geoCache', { enumerable: false });
  Object.defineProperty(map, 'static', { enumerable: false });
  map._prepared = true;
  Object.defineProperty(map, '_prepared', { enumerable: false });
  return map;
}

export function doorBox(d) {
  return { minX: d.minX, maxX: d.maxX, minZ: d.minZ, maxZ: d.maxZ, h: 2.4, level: d.level, kind: 'door', solid: true, sight: true };
}

/** Collision / sight geometry for one level given the current door state string. */
export function levelGeo(map, level, doorState = '') {
  const key = `${level}|${doorState}`;
  let g = map._geoCache.get(key);
  if (g) return g;
  const st = map.static[level] || { solids: [], sightBlockers: [] };
  const closed = [];
  map.doors.forEach((d, i) => {
    if (d.level === level && (doorState[i] ?? (d.open ? '1' : '0')) !== '1') closed.push(doorBox(d));
  });
  g = { size: map.size, level, solids: [...st.solids, ...closed], sightBlockers: [...st.sightBlockers, ...closed] };
  g.solidGrid = buildGrid(g.solids, map.size);
  g.sightGrid = buildGrid(g.sightBlockers, map.size);
  if (map._geoCache.size > 64) map._geoCache.clear();
  map._geoCache.set(key, g);
  return g;
}

export function roomAt(map, x, z, level) {
  for (const r of map.rooms) if (r.level === level && pointInBox(x, z, r)) return r;
  return null;
}

export function houseAt(map, x, z) {
  for (const h of map.houses) if (pointInBox(x, z, h)) return h;
  return null;
}

/** Is this spot dark right now (basement, or a room with its light switched off)? */
export function isDarkSpot(map, x, z, level, lightState = '') {
  const r = roomAt(map, x, z, level);
  if (!r) return false;
  if (r.alwaysDark) return true;
  return (lightState[r.id] ?? (r.lightOn ? '1' : '0')) === '0';
}

/** Hiding spot under the player (bush, under a bed, behind a curtain), or null. */
export function hideSpotAt(map, x, z, level) {
  if (level === 0) for (const b of map.bushes) if (dist2D(x, z, b.x, b.z) <= b.r) return b;
  for (const h of map.hideZones) if (h.level === level && pointInBox(x, z, h)) return h;
  return null;
}

/** Can the player stand on this level at x,z? Level 0 is everywhere; other levels need a floor. */
export function hasFloor(map, x, z, level) {
  // Stairwell openings have no floor (the ramp below is handled by stairAt / floorHeight)
  for (const s of map.stairs) if (Math.max(s.from, s.to) === level && pointInBox(x, z, s, -0.02)) return false;
  if (level === 0) return true;
  return map.floors.some((f) => f.level === level && pointInBox(x, z, f, 0.05));
}

/**
 * Nearest thing the player can interact with using F (wardrobes/lockers, vents, light switches,
 * security monitors). Doors open by themselves and stairs are walked.
 * state: { lockerOcc: Set|Map (occupied locker ids) }
 */
export function findInteractable(map, x, z, level, state = {}) {
  let best = null;
  const consider = (type, obj, d, range) => {
    if (d <= range && (!best || d < best.dist)) best = { type, id: obj.id, obj, dist: d };
  };
  const sec = map.security;
  if (sec && sec.level === level) consider('monitor', { id: 0 }, dist2D(x, z, sec.monitor.x, sec.monitor.z), INTERACT_RANGE);
  for (const v of map.vents) if (v.level === level) consider('vent', v, dist2D(x, z, v.x, v.z), 1.3);
  for (const l of map.lockers) {
    if (l.level !== level) continue;
    if (state.lockerOcc && state.lockerOcc.has(l.id)) continue;
    consider('locker', l, dist2D(x, z, l.exitX, l.exitZ), LOCKER_RANGE);
  }
  for (const s of map.switches) if (s.level === level) consider('switch', s, dist2D(x, z, s.x, s.z), 1.3);
  return best;
}

// ---------------------------------------------------------------------------------------------
// Walkable stairs. A staircase is a ramp footprint linking level `from` (entry edge) to level `to`
// (exit edge). Inside it your height follows the ramp; you belong to whichever level you're closer to.
// ---------------------------------------------------------------------------------------------
export function stairProgress(s, x, z) {
  return ((x - s.sx) * s.dir[0] + (z - s.sz) * s.dir[1]) / s.len;
}

/** The staircase whose footprint contains (x, z) and connects to `level`, with progress t (0 entry .. 1 exit). */
export function stairAt(map, x, z, level) {
  for (const s of map.stairs) {
    if (s.from !== level && s.to !== level) continue;
    if (!pointInBox(x, z, s)) continue;
    const t = Math.max(0, Math.min(1, stairProgress(s, x, z)));
    return { stair: s, t };
  }
  return null;
}

/** Level after standing at (x, z): flips half way up/down a ramp. */
export function resolveStairs(map, x, z, level) {
  const hit = stairAt(map, x, z, level);
  if (!hit) return level;
  return hit.t >= 0.5 ? hit.stair.to : hit.stair.from;
}

/** Height of the floor under (x, z) for someone on `level` (follows ramps). */
export function floorHeight(map, x, z, level) {
  const hit = stairAt(map, x, z, level);
  if (!hit) return level * LEVEL_HEIGHT;
  const { stair, t } = hit;
  return (stair.from + (stair.to - stair.from) * t) * LEVEL_HEIGHT;
}

/** Door state as the mover's own client should predict it: normal doors near you are open. */
export function predictedDoorState(map, doorState, x, z, level) {
  let out = '';
  for (const d of map.doors) {
    const c = doorState[d.id] ?? '0';
    if (c === '0' && d.level === level && dist2D(x, z, (d.minX + d.maxX) / 2, (d.minZ + d.maxZ) / 2) <= DOOR_OPEN_RANGE) out += '1';
    else out += c;
  }
  return out;
}

/** Nearest door (any state) within range on the level. */
export function nearestDoor(map, x, z, level, range = INTERACT_RANGE + 0.4) {
  let best = null;
  let bd = range;
  for (const d of map.doors) {
    if (d.level !== level) continue;
    const dd = dist2D(x, z, (d.minX + d.maxX) / 2, (d.minZ + d.maxZ) / 2);
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return best;
}
