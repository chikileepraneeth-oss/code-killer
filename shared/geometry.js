// 2D (x/z plane) collision + line-of-sight helpers. Pure functions, shared by server and client.
// "geo" is any object with { size, solids: Box[], sightBlockers: Box[] } - normally one level of a map
// (see levelGeo() in world.js), which already includes closed doors.

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function pointInBox(x, z, b, pad = 0) {
  return x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad;
}

export function dist2D(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------------------------------------
// Uniform-grid broadphase: collision and line-of-sight only test boxes in nearby cells.
// ---------------------------------------------------------------------------------------------
let STAMP = 1;
const SCRATCH = [];

export function buildGrid(boxes, size, cell = 4) {
  const half = size / 2 + 2;
  const n = Math.ceil((half * 2) / cell);
  const cells = Array.from({ length: n * n }, () => []);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor((b.minX + half) / cell));
    const x1 = Math.min(n - 1, Math.floor((b.maxX + half) / cell));
    const z0 = Math.max(0, Math.floor((b.minZ + half) / cell));
    const z1 = Math.min(n - 1, Math.floor((b.maxZ + half) / cell));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells[z * n + x].push(b);
  }
  return { cell, n, half, cells };
}

/** Boxes whose cells overlap the rectangle. Returns a shared scratch array (use it immediately). */
function query(grid, minX, minZ, maxX, maxZ) {
  STAMP++;
  SCRATCH.length = 0;
  const { cell, n, half, cells } = grid;
  const x0 = Math.max(0, Math.floor((minX + half) / cell));
  const x1 = Math.min(n - 1, Math.floor((maxX + half) / cell));
  const z0 = Math.max(0, Math.floor((minZ + half) / cell));
  const z1 = Math.min(n - 1, Math.floor((maxZ + half) / cell));
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      for (const b of cells[z * n + x]) {
        if (b._s === STAMP) continue;
        b._s = STAMP;
        SCRATCH.push(b);
      }
    }
  }
  return SCRATCH;
}

function solidsNear(geo, x, z, r) {
  return geo.solidGrid ? query(geo.solidGrid, x - r, z - r, x + r, z + r) : geo.solids;
}

/** Push a circle out of one AABB. Returns {x,z} or null when not overlapping. */
export function pushOutOfBox(x, z, r, b) {
  if (x < b.minX - r || x > b.maxX + r || z < b.minZ - r || z > b.maxZ + r) return null;
  const cx = clamp(x, b.minX, b.maxX);
  const cz = clamp(z, b.minZ, b.maxZ);
  const dx = x - cx;
  const dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    const push = r - d;
    return { x: x + (dx / d) * push, z: z + (dz / d) * push };
  }
  const left = x - b.minX;
  const right = b.maxX - x;
  const top = z - b.minZ;
  const bottom = b.maxZ - z;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: b.minX - r, z };
  if (m === right) return { x: b.maxX + r, z };
  if (m === top) return { x, z: b.minZ - r };
  return { x, z: b.maxZ + r };
}

/** Resolve a circle against all solid boxes + map bounds. */
export function resolveCollisions(geo, x, z, r) {
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const b of solidsNear(geo, x, z, r + 0.05)) {
      const p = pushOutOfBox(x, z, r, b);
      if (p) {
        x = p.x;
        z = p.z;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const h = geo.size / 2 - r;
  return { x: clamp(x, -h, h), z: clamp(z, -h, h) };
}

/** Move with collisions, sub-stepping so fast moves can't tunnel through thin walls. */
export function moveWithCollisions(geo, x, z, dx, dz, r) {
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / 0.12));
  const sx = dx / steps;
  const sz = dz / steps;
  let p = { x, z };
  for (let i = 0; i < steps; i++) p = resolveCollisions(geo, p.x + sx, p.z + sz, r);
  return p;
}

export function collides(geo, x, z, r) {
  for (const b of solidsNear(geo, x, z, r)) if (pushOutOfBox(x, z, r, b)) return true;
  return false;
}

/** Does segment A->B intersect an AABB? (slab method, 2D) */
export function segmentIntersectsBox(ax, az, bx, bz, b) {
  if (Math.max(ax, bx) < b.minX || Math.min(ax, bx) > b.maxX || Math.max(az, bz) < b.minZ || Math.min(az, bz) > b.maxZ) return false;
  let tmin = 0;
  let tmax = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) < 1e-9) {
    if (ax < b.minX || ax > b.maxX) return false;
  } else {
    let t1 = (b.minX - ax) / dx;
    let t2 = (b.maxX - ax) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-9) {
    if (az < b.minZ || az > b.maxZ) return false;
  } else {
    let t1 = (b.minZ - az) / dz;
    let t2 = (b.maxZ - az) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

/** Distance from point P to segment AB. */
export function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  return dist2D(px, pz, ax + dx * t, az + dz * t);
}

/** Does segment A->B pass through (or start/end inside) a circle? */
export function segmentHitsCircle(ax, az, bx, bz, c) {
  return pointSegmentDistance(c.x, c.z, ax, az, bx, bz) < c.r;
}

/** Line of sight between two points on the same level; tall geometry and closed doors block it. */
export function hasLineOfSight(geo, ax, az, bx, bz) {
  const list = geo.sightGrid
    ? query(geo.sightGrid, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz))
    : geo.sightBlockers;
  for (const b of list) if (segmentIntersectsBox(ax, az, bx, bz, b)) return false;
  return true;
}

/** Cast a ray and return the farthest free point (stops just before sight-blocking geometry). */
export function castRay(geo, x, z, dirX, dirZ, maxDist, step = 0.25) {
  let px = x;
  let pz = z;
  for (let d = step; d <= maxDist; d += step) {
    const nx = x + dirX * d;
    const nz = z + dirZ * d;
    if (!hasLineOfSight(geo, px, pz, nx, nz) || Math.abs(nx) > geo.size / 2 - 0.5 || Math.abs(nz) > geo.size / 2 - 0.5) break;
    px = nx;
    pz = nz;
  }
  return { x: px, z: pz };
}
