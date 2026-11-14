// Multi-level grid navigation (A*) for bots. Levels are linked through stairs.
// Ordinary doors are walkable (bots open them); sealed shortcut doors are treated as walls.
import { collides, pointInBox } from '../../shared/geometry.js';
import { hasFloor } from '../../shared/world.js';

const CELL = 0.5;
const CLEARANCE = 0.36;
const cache = new WeakMap();

function buildGrid(map) {
  const n = Math.round(map.size / CELL);
  const half = map.size / 2;
  const levels = map.levels;
  const L = levels.length;
  const walk = new Uint8Array(L * n * n);
  const geos = levels.map((lv) => {
    const st = map.static[lv];
    const sealed = map.doors.filter((d) => d.level === lv && d.special);
    return { size: map.size, solids: [...st.solids, ...sealed], sightBlockers: [] };
  });
  const cells = levels.map(() => []);
  for (let li = 0; li < L; li++) {
    const lv = levels[li];
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = -half + (ix + 0.5) * CELL;
        const z = -half + (iz + 0.5) * CELL;
        if (lv !== 0 && !hasFloor(map, x, z, lv)) continue;
        if (collides(geos[li], x, z, CLEARANCE)) continue;
        // Ramps are traversed through the stair links below, never wandered onto
        if (map.stairs.some((st) => (st.from === lv || st.to === lv) && pointInBox(x, z, st, 0.3))) continue;
        const i = li * n * n + iz * n + ix;
        walk[i] = 1;
        cells[li].push(i);
      }
    }
  }
  const total = L * n * n;
  const g = {
    n, half, levels, walk, cells, links: new Map(),
    // Reusable A* scratch buffers (stamp-based reset)
    gScore: new Float32Array(total), came: new Int32Array(total), viaStair: new Int32Array(total),
    stamp: new Uint32Array(total), closedStamp: new Uint32Array(total), run: 0,
  };
  // Stair links (both directions): from just before the ramp on one floor to just past it on the other
  for (const s of map.stairs) {
    const ia = nearestWalkable(g, s.a.x, s.a.z, s.a.level);
    const ib = nearestWalkable(g, s.b.x, s.b.z, s.b.level);
    if (ia === null || ib === null) continue;
    if (!g.links.has(ia)) g.links.set(ia, []);
    if (!g.links.has(ib)) g.links.set(ib, []);
    const cost = s.len * 2 + 2;
    g.links.get(ia).push({ to: ib, stair: s.id, cost });
    g.links.get(ib).push({ to: ia, stair: s.id, cost });
  }
  labelComponents(g);
  return g;
}

/**
 * Connected regions (8-neighbour moves + stair links). Lets findPath reject unreachable goals
 * instantly (e.g. rooms behind sealed doors) instead of flooding the whole map, and lets bots pick
 * random destinations only where they can actually go.
 */
function labelComponents(g) {
  const nn = g.n * g.n;
  const comp = new Int32Array(g.walk.length).fill(-1);
  const sizes = [];
  const stack = [];
  for (let s0 = 0; s0 < g.walk.length; s0++) {
    if (!g.walk[s0] || comp[s0] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    comp[s0] = id;
    stack.push(s0);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      const li = Math.floor(cur / nn);
      const r = cur % nn;
      const cx = r % g.n;
      const cz = Math.floor(r / g.n);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const nz = cz + dz;
          if ((!dx && !dz) || nx < 0 || nz < 0 || nx >= g.n || nz >= g.n) continue;
          const ni = li * nn + nz * g.n + nx;
          if (!g.walk[ni] || comp[ni] >= 0) continue;
          if (dx && dz && (!g.walk[li * nn + cz * g.n + nx] || !g.walk[li * nn + nz * g.n + cx])) continue;
          comp[ni] = id;
          stack.push(ni);
        }
      }
      for (const link of g.links.get(cur) || []) {
        if (comp[link.to] >= 0) continue;
        comp[link.to] = id;
        stack.push(link.to);
      }
    }
    sizes.push(size);
  }
  g.comp = comp;
  g.mainComp = sizes.indexOf(Math.max(...sizes));
  g.reachable = g.cells.map((list) => list.filter((i) => comp[i] === g.mainComp));
}

// The village is the same every round: its grid is built once per process, not once per round
const fixedCache = new Map();

export function getNavGrid(map) {
  let g = cache.get(map);
  if (!g) {
    const key = map.sizeClass === 'fixed' && map.id ? `${map.id}|${map.boxes.length}|${map.doors.length}` : null;
    g = (key && fixedCache.get(key)) || buildGrid(map);
    if (key) fixedCache.set(key, g);
    cache.set(map, g);
  }
  return g;
}

function levelIndex(g, level) {
  const i = g.levels.indexOf(level);
  return i < 0 ? 0 : i;
}

function cellOf(g, x, z, level) {
  const ix = Math.max(0, Math.min(g.n - 1, Math.floor((x + g.half) / CELL)));
  const iz = Math.max(0, Math.min(g.n - 1, Math.floor((z + g.half) / CELL)));
  return levelIndex(g, level) * g.n * g.n + iz * g.n + ix;
}

function decode(g, i) {
  const nn = g.n * g.n;
  const li = Math.floor(i / nn);
  const r = i % nn;
  const ix = r % g.n;
  const iz = Math.floor(r / g.n);
  return { li, ix, iz, x: -g.half + (ix + 0.5) * CELL, z: -g.half + (iz + 0.5) * CELL, level: g.levels[li] };
}

function nearestWalkable(g, x, z, level) {
  const c = cellOf(g, x, z, level);
  if (g.walk[c]) return c;
  const { li, ix, iz } = decode(g, c);
  for (let r = 1; r < 10; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = ix + dx;
        const nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= g.n || nz >= g.n) continue;
        const i = li * g.n * g.n + nz * g.n + nx;
        if (g.walk[i]) return i;
      }
    }
  }
  return null;
}

export function randomWalkablePoint(map, filter = null, level = 0) {
  const g = getNavGrid(map);
  const list = g.reachable[levelIndex(g, level)].length ? g.reachable[levelIndex(g, level)] : g.cells[levelIndex(g, level)];
  if (!list.length) return { x: 0, z: 0, level };
  for (let i = 0; i < 50; i++) {
    const p = decode(g, list[Math.floor(Math.random() * list.length)]);
    const q = { x: p.x, z: p.z, level: p.level };
    if (!filter || filter(q)) return q;
  }
  const p = decode(g, list[Math.floor(Math.random() * list.length)]);
  return { x: p.x, z: p.z, level: p.level };
}

/**
 * A* path between two points (possibly on different levels).
 * Returns waypoints [{x, z, level, stair?}] where `stair` marks "use these stairs to reach this waypoint".
 */
export function findPath(map, from, to) {
  const g = getNavGrid(map);
  const start = nearestWalkable(g, from.x, from.z, from.level ?? 0);
  const goal = nearestWalkable(g, to.x, to.z, to.level ?? 0);
  if (start === null || goal === null) return null;
  if (start === goal) return [{ x: to.x, z: to.z, level: to.level ?? 0 }];
  if (g.comp[start] !== g.comp[goal]) return null; // different region (e.g. behind a sealed door): no search needed
  const nn = g.n * g.n;
  const run = ++g.run;
  const { gScore, came, viaStair, stamp, closedStamp } = g;
  const G = (i) => (stamp[i] === run ? gScore[i] : Infinity);
  const setG = (i, v, from, st) => {
    stamp[i] = run;
    gScore[i] = v;
    came[i] = from;
    viaStair[i] = st;
  };
  const isClosed = (i) => closedStamp[i] === run;
  const heap = [];
  const push = (f, i) => {
    heap.push([f, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  const gd = decode(g, goal);
  const h = (i) => {
    const d = decode(g, i);
    const dx = Math.abs(d.ix - gd.ix);
    const dz = Math.abs(d.iz - gd.iz);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz) + (d.li !== gd.li ? 4 : 0);
  };
  setG(start, 0, -1, -1);
  push(h(start), start);
  let found = false;
  let iterations = 0;
  while (heap.length && iterations++ < 60000) {
    const [, cur] = pop();
    if (cur === goal) {
      found = true;
      break;
    }
    if (isClosed(cur)) continue;
    closedStamp[cur] = run;
    const li = Math.floor(cur / nn);
    const r = cur % nn;
    const cx = r % g.n;
    const cz = Math.floor(r / g.n);
    const base = li * nn;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= g.n || nz >= g.n) continue;
        const ni = base + nz * g.n + nx;
        if (!g.walk[ni] || isClosed(ni)) continue;
        if (dx && dz && (!g.walk[base + cz * g.n + nx] || !g.walk[base + nz * g.n + cx])) continue;
        const cost = G(cur) + (dx && dz ? 1.414 : 1);
        if (cost < G(ni)) {
          setG(ni, cost, cur, -1);
          push(cost + h(ni), ni);
        }
      }
    }
    for (const link of g.links.get(cur) || []) {
      if (isClosed(link.to)) continue;
      const cost = G(cur) + link.cost;
      if (cost < G(link.to)) {
        setG(link.to, cost, cur, link.stair);
        push(cost + h(link.to), link.to);
      }
    }
  }
  if (!found) return null;
  const raw = [];
  for (let c = goal; c !== start && c !== -1; c = stamp[c] === run ? came[c] : -1) {
    const d = decode(g, c);
    raw.push({ x: d.x, z: d.z, level: d.level, stair: viaStair[c] >= 0 ? viaStair[c] : undefined });
  }
  raw.reverse();
  // String-pulling within a level (never across stairs)
  const clear = (a, b) => {
    if (a.level !== b.level || b.stair !== undefined) return false;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.ceil(len / 0.4);
    for (let i = 1; i < steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const z = a.z + ((b.z - a.z) * i) / steps;
      if (!g.walk[cellOf(g, x, z, a.level)]) return false;
    }
    return true;
  };
  const out = [];
  let anchor = { x: from.x, z: from.z, level: from.level ?? 0 };
  let i = 0;
  while (i < raw.length) {
    if (raw[i].stair !== undefined) {
      out.push(raw[i]);
      anchor = raw[i];
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < raw.length && j - i < 24 && clear(anchor, raw[j + 1])) j++;
    out.push(raw[j]);
    anchor = raw[j];
    i = j + 1;
  }
  return out;
}
