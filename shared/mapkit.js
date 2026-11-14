// Building blocks for hand-designed maps: a Builder that places walls (with doors/windows),
// rooms, furniture, hiding spots and walkable stairs in local coordinates, transformed by
// rotation / mirroring / offset into world space. Output is plain JSON-able map data.
import { LEVEL_HEIGHT } from './constants.js';

export const H = LEVEL_HEIGHT;
export const WALL_T = 0.3;

export function emptyMap() {
  return {
    boxes: [], floors: [], houses: [], rooms: [], switches: [], doors: [], windows: [],
    bushes: [], hideZones: [], lockers: [], stairs: [], vents: [], ducts: [], security: null,
    mirrors: [], puddles: [], decoys: [], lamps: [], emergencyLights: [], decor: [],
    spawns: [], itemSpots: [],
  };
}

export function splitRange(a, b, gaps = []) {
  const segs = [];
  let cur = a;
  for (const [g0, g1] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (g0 > cur) segs.push([cur, g0]);
    cur = Math.max(cur, g1);
  }
  if (cur < b) segs.push([cur, b]);
  return segs;
}

const r3 = (v) => +v.toFixed(3);

/** a minus b for axis-aligned rects: up to 4 non-overlapping pieces (same extra fields as a). */
export function rectMinus(a, b) {
  if (b.maxX <= a.minX || b.minX >= a.maxX || b.maxZ <= a.minZ || b.minZ >= a.maxZ) return [a];
  const out = [];
  const piece = (minX, maxX, minZ, maxZ) => {
    if (maxX - minX > 1e-6 && maxZ - minZ > 1e-6) out.push({ ...a, minX, maxX, minZ, maxZ });
  };
  piece(a.minX, Math.max(a.minX, b.minX), a.minZ, a.maxZ); // west strip
  piece(Math.min(a.maxX, b.maxX), a.maxX, a.minZ, a.maxZ); // east strip
  const x0 = Math.max(a.minX, b.minX);
  const x1 = Math.min(a.maxX, b.maxX);
  piece(x0, x1, a.minZ, Math.max(a.minZ, b.minZ)); // north strip
  piece(x0, x1, Math.min(a.maxZ, b.maxZ), a.maxZ); // south strip
  return out;
}

/** Every rect in `list` minus every hole. */
export function rectsMinus(list, holes) {
  let out = list;
  for (const h of holes) out = out.flatMap((r) => rectMinus(r, h));
  return out;
}

/** The opening each staircase needs: its footprint, cut out of the floor of the upper of its two levels. */
export function stairHoles(map) {
  return map.stairs.map((s) => ({ level: Math.max(s.from, s.to), minX: s.minX, maxX: s.maxX, minZ: s.minZ, maxZ: s.maxZ, stairId: s.id }));
}

/**
 * Cut a real rectangular opening above (or, for basement stairs, at the top of) every staircase:
 * the floor slab of that level becomes pieces around the hole. Idempotent.
 */
export function carveStairwells(map) {
  const holes = stairHoles(map);
  map.floors = map.floors.flatMap((f) => rectsMinus([f], holes.filter((h) => h.level === f.level)));
  // A ceiling lamp of the floor below can't hang inside the opening: move it beside the opening,
  // onto the widest strip of real ceiling left in its room
  for (const l of map.lamps || []) {
    if (l.kind !== 'ceiling') continue;
    const h = holes.find((o) => o.level === l.level + 1 && l.x > o.minX - 0.35 && l.x < o.maxX + 0.35 && l.z > o.minZ - 0.35 && l.z < o.maxZ + 0.35);
    if (!h) continue;
    const r = (map.rooms || []).find((q) => q.level === l.level && l.x >= q.minX && l.x <= q.maxX && l.z >= q.minZ && l.z <= q.maxZ);
    if (!r) continue;
    const strips = rectMinus(r, { minX: h.minX - 0.15, maxX: h.maxX + 0.15, minZ: h.minZ - 0.15, maxZ: h.maxZ + 0.15 });
    const best = strips.sort((p, q) => (q.maxX - q.minX) * (q.maxZ - q.minZ) - (p.maxX - p.minX) * (p.maxZ - p.minZ))[0];
    if (best) {
      l.x = Math.round(((best.minX + best.maxX) / 2) * 100) / 100;
      l.z = Math.round(((best.minZ + best.maxZ) / 2) * 100) / 100;
    }
  }
  return map;
}

export class Builder {
  /** rot: quarter turns; mirror: flip local x before rotating; (ox, oz): world offset */
  constructor(M, { rot = 0, mirror = false, ox = 0, oz = 0, houseId } = {}) {
    this.M = M;
    this.rot = rot;
    this.flip = mirror;
    this.ox = ox;
    this.oz = oz;
    this.houseId = houseId;
  }

  vec(x, z) {
    const mx = this.flip ? -x : x;
    switch (this.rot) {
      case 1: return [-z, mx];
      case 2: return [-mx, -z];
      case 3: return [z, -mx];
      default: return [mx, z];
    }
  }

  pt(x, z) {
    const [rx, rz] = this.vec(x, z);
    return { x: r3(rx + this.ox), z: r3(rz + this.oz) };
  }

  yaw(localYaw) {
    const [dx, dz] = this.vec(Math.sin(localYaw), Math.cos(localYaw));
    return +Math.atan2(dx, dz).toFixed(4);
  }

  rect(x0, z0, x1, z1) {
    const a = this.pt(x0, z0);
    const b = this.pt(x1, z1);
    return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
  }

  box(x0, z0, x1, z1, h, kind, o = {}) {
    const b = {
      ...this.rect(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)),
      h, kind, level: o.level ?? 0, y0: o.y0 ?? 0,
      solid: o.solid !== false, sight: o.sight ?? (h >= 1.6 && (o.y0 ?? 0) < 1),
    };
    if (o.color) b.color = o.color;
    const hid = o.houseId ?? this.houseId;
    if (hid !== undefined) b.houseId = hid;
    this.M.boxes.push(b);
    return b;
  }

  /** Axis-aligned wall with openings [{a, b, type: 'door'|'window'|'gap', special, sill}] along its length. */
  wall(x0, z0, x1, z1, o = {}) {
    const level = o.level ?? 0;
    const h = o.h ?? H;
    const t = o.t ?? WALL_T;
    const kind = o.kind ?? 'wall';
    const horizontal = z0 === z1;
    const lo = horizontal ? Math.min(x0, x1) : Math.min(z0, z1);
    const hi = horizontal ? Math.max(x0, x1) : Math.max(z0, z1);
    const c = horizontal ? z0 : x0;
    const ext = o.extend ? t / 2 : 0;
    const openings = (o.openings || []).map((op) => ({ ...op }));
    const mk = (a, b, hh, extra = {}) => (horizontal
      ? this.box(a, c - t / 2, b, c + t / 2, hh, extra.kind ?? kind, { level, ...extra })
      : this.box(c - t / 2, a, c + t / 2, b, hh, extra.kind ?? kind, { level, ...extra }));
    for (const [a, b] of splitRange(lo - ext, hi + ext, openings.map((op) => [op.a, op.b]))) mk(a, b, h);
    for (const op of openings) {
      if (op.type === 'window') {
        const sill = op.sill ?? 1.0;
        mk(op.a, op.b, sill, { kind: 'sill', sight: false });
        mk(op.a, op.b, h - 2.2, { kind: 'lintel', y0: 2.2, solid: false, sight: false });
        const r = horizontal ? this.rect(op.a, c - 0.02, op.b, c + 0.02) : this.rect(c - 0.02, op.a, c + 0.02, op.b);
        this.M.windows.push({ ...r, level, y0: sill, y1: 2.2, store: !!op.store });
      } else {
        if (h > 2.4) mk(op.a, op.b, h - 2.4, { kind: 'lintel', y0: 2.4, solid: false, sight: false });
        if (op.type === 'door') {
          const r = horizontal ? this.rect(op.a, c - 0.08, op.b, c + 0.08) : this.rect(c - 0.08, op.a, c + 0.08, op.b);
          const d = { id: this.M.doors.length, ...r, level, houseId: o.houseId ?? this.houseId ?? -1, open: false, special: !!op.special };
          d.axis = d.maxX - d.minX > d.maxZ - d.minZ ? 'x' : 'z';
          if (op.note) d.note = op.note;
          this.M.doors.push(d);
          op.doorId = d.id;
        }
      }
    }
    return openings;
  }

  /** Four outer walls of a rectangle; openings per side: { n: [...], s: [...], w: [...], e: [...] }. */
  shell(x0, z0, x1, z1, level, sides = {}, h = H) {
    this.wall(x0, z0, x1, z0, { level, h, extend: true, openings: sides.n });
    this.wall(x0, z1, x1, z1, { level, h, extend: true, openings: sides.s });
    this.wall(x0, z0, x0, z1, { level, h, openings: sides.w });
    this.wall(x1, z0, x1, z1, { level, h, openings: sides.e });
  }

  floor(x0, z0, x1, z1, level, kind, houseId = this.houseId) {
    const f = { ...this.rect(x0, z0, x1, z1), level, kind, houseId };
    this.M.floors.push(f);
    return f;
  }

  room(x0, z0, x1, z1, level, kind, o = {}) {
    const r = { id: this.M.rooms.length, ...this.rect(x0, z0, x1, z1), level, houseId: o.houseId ?? this.houseId ?? -1, kind, lightOn: o.lightOn !== false, alwaysDark: !!o.alwaysDark };
    this.M.rooms.push(r);
    if (!r.alwaysDark && o.lamp !== false) {
      const c = this.pt((x0 + x1) / 2, (z0 + z1) / 2);
      this.M.lamps.push({ ...c, level, y: H - 0.35, kind: 'ceiling', roomId: r.id });
    }
    return r;
  }

  /** Light switch for `room`, placed just off a wall face (render code snaps it flush). */
  switchFor(room, x, z) {
    this.M.switches.push({ id: this.M.switches.length, roomId: room.id, ...this.pt(x, z), level: room.level });
  }

  /** Wardrobe / locker against a wall, door facing (fx, fz). Hiding spot (enter with F). */
  locker(x, z, fx, fz, level, kind = 'wardrobe') {
    const alongX = fx !== 0;
    const hw = alongX ? 0.3 : 0.5;
    const hd = alongX ? 0.5 : 0.3;
    const p = this.pt(x, z);
    const [wfx, wfz] = this.vec(fx, fz);
    const box = this.box(x - hw, z - hd, x + hw, z + hd, 2.1, kind === 'wardrobe' ? 'wardrobe' : 'locker', { level });
    const l = {
      id: this.M.lockers.length, kind, x: p.x, z: p.z, level, fx: wfx, fz: wfz,
      yaw: +Math.atan2(wfx, wfz).toFixed(4),
      exitX: r3(p.x + wfx * 0.95), exitZ: r3(p.z + wfz * 0.95), box,
    };
    this.M.lockers.push(l);
    return l;
  }

  hideZone(x0, z0, x1, z1, level, kind) {
    const h = { ...this.rect(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)), level, kind };
    this.M.hideZones.push(h);
    return h;
  }

  /** Bed (lie under it to hide). */
  bed(x0, z0, x1, z1, level) {
    this.box(x0, z0, x1, z1, 0.55, 'bed', { level, solid: false, sight: false });
    return this.hideZone(x0, z0, x1, z1, level, 'bed');
  }

  /** Curtain hiding spot: zone + a hanging curtain on its room-facing edge. alongX = curtain runs along x. */
  curtain(x0, z0, x1, z1, level, alongX, hangAtMax) {
    this.hideZone(x0, z0, x1, z1, level, 'curtain');
    const cx = alongX ? (x0 + x1) / 2 : (hangAtMax ? Math.max(x0, x1) : Math.min(x0, x1));
    const cz = alongX ? (hangAtMax ? Math.max(z0, z1) : Math.min(z0, z1)) : (z0 + z1) / 2;
    this.decor('curtain', cx, cz, { level, w: +(Math.abs(alongX ? x1 - x0 : z1 - z0) + 0.1).toFixed(2), yaw: alongX ? 0 : Math.PI / 2 });
  }

  mirror(x, z, nx, nz, level, w = 0.9) {
    const [wx, wz] = this.vec(nx, nz);
    this.M.mirrors.push({ ...this.pt(x, z), nx: wx, nz: wz, level, w, y0: 0.9, y1: 2.2 });
  }

  bush(x, z, r) {
    this.M.bushes.push({ ...this.pt(x, z), r: +r.toFixed(2) });
  }

  puddle(x, z, r) {
    this.M.puddles.push({ ...this.pt(x, z), r: +r.toFixed(2) });
  }

  lamp(x, z, level, kind = 'lantern', y = 3.4) {
    this.M.lamps.push({ ...this.pt(x, z), level, y, kind });
  }

  item(x, z, level = 0) {
    this.M.itemSpots.push({ ...this.pt(x, z), level });
  }

  spawn(x, z) {
    this.M.spawns.push(this.pt(x, z));
  }

  vent(x, z, level) {
    const v = { id: this.M.vents.length, ...this.pt(x, z), level };
    this.M.vents.push(v);
    return v;
  }

  decor(type, x, z, o = {}) {
    const d = { type, ...this.pt(x, z), ...o };
    if (o.yaw !== undefined) d.yaw = this.yaw(o.yaw);
    this.M.decor.push(d);
  }

  /**
   * Walkable staircase. Footprint (x0,z0)-(x1,z1) in local coords; `dir` = local unit axis vector from the
   * entry edge (on level `from`) to the exit edge (on level `to`). Rails keep people from stepping onto the
   * ramp from the side or falling into the stairwell.
   */
  stairs(x0, z0, x1, z1, dir, from, to, style = 'stairs') {
    const [dx, dz] = dir;
    const alongZ = dz !== 0;
    const len = alongZ ? z1 - z0 : x1 - x0;
    // entry edge midpoint (local)
    const ex = alongZ ? (x0 + x1) / 2 : dx > 0 ? x0 : x1;
    const ez = alongZ ? (dz > 0 ? z0 : z1) : (z0 + z1) / 2;
    const xx = alongZ ? ex : dx > 0 ? x1 : x0;
    const xz = alongZ ? (dz > 0 ? z1 : z0) : ez;
    const T = 0.1;
    const railH = 1.05;
    const rail = (rx0, rz0, rx1, rz1, level) => this.box(rx0, rz0, rx1, rz1, railH, 'stairrail', { level, sight: false });
    for (const level of [from, to]) {
      if (alongZ) {
        rail(x0 - T, z0, x0, z1, level);
        rail(x1, z0, x1 + T, z1, level);
      } else {
        rail(x0, z0 - T, x1, z0, level);
        rail(x0, z1, x1, z1 + T, level);
      }
    }
    // Close the far end on the lower path and the near end on the upper path
    // sgn +1 = beyond the exit edge, -1 = before the entry edge (both outside the footprint)
    const endRail = (px, pz, level, sgn) => {
      if (alongZ) rail(x0 - T, Math.min(pz, pz + sgn * dz * T), x1 + T, Math.max(pz, pz + sgn * dz * T), level);
      else rail(Math.min(px, px + sgn * dx * T), z0 - T, Math.max(px, px + sgn * dx * T), z1 + T, level);
    };
    endRail(xx, xz, from, 1);
    endRail(ex, ez, to, -1);
    const [wdx, wdz] = this.vec(dx, dz);
    const entry = this.pt(ex, ez);
    const s = {
      id: this.M.stairs.length, style, from, to,
      ...this.rect(x0, z0, x1, z1),
      dir: [r3(wdx), r3(wdz)], len: Math.abs(len), width: Math.abs(alongZ ? x1 - x0 : z1 - z0),
      sx: entry.x, sz: entry.z,
      a: { ...this.pt(ex - dx * 0.6, ez - dz * 0.6), level: from },
      b: { ...this.pt(xx + dx * 0.6, xz + dz * 0.6), level: to },
    };
    this.M.stairs.push(s);
    return s;
  }
}
