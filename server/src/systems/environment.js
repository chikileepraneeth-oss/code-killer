// Interactive environment: automatic doors, sealed doors, light switches, walkable stairs, lockers/wardrobes,
// vents, the security room, reflections (mirrors / puddles) and the Lights Out event. Mixed into Room.prototype.
import {
  DOOR_CLOSE_DELAY, DOOR_CLOSE_RANGE, DOOR_OPEN_RANGE, LIGHTS_OUT_MAX, LIGHTS_OUT_MIN, LIGHTS_OUT_WARNING, PLAYER_RADIUS,
  REFLECT, VENT_SPEED,
} from '../../../shared/constants.js';
import { dist2D, pushOutOfBox, resolveCollisions } from '../../../shared/geometry.js';
import { findInteractable, levelGeo, resolveStairs } from '../../../shared/world.js';

const rand = (a, b) => a + Math.random() * (b - a);
const doorCenter = (d) => [(d.minX + d.maxX) / 2, (d.minZ + d.maxZ) / 2];

/** Which mirror / puddle (if any) the player is looking into. Exported for tests. */
export function reflectionSource(map, p) {
  const lx = p.lookX ?? 0;
  const lz = p.lookZ ?? 1;
  for (const m of map.mirrors) {
    if (m.level !== (p.level ?? 0)) continue;
    const vx = p.x - m.x;
    const vz = p.z - m.z;
    const along = vx * m.nx + vz * m.nz; // distance in front of the mirror
    const lateral = Math.abs(vx * -m.nz + vz * m.nx);
    if (along <= 0.1 || along > REFLECT.RANGE || lateral > m.w / 2 + 0.6) continue;
    if (-(lx * m.nx + lz * m.nz) > Math.cos(0.9)) return { kind: 'mirror', obj: m };
  }
  if ((p.level ?? 0) === 0) {
    for (const pd of map.puddles) {
      const d = dist2D(p.x, p.z, pd.x, pd.z);
      if (d > pd.r + REFLECT.RANGE - 0.6) continue;
      if (d <= pd.r && (p.viewPitch ?? 0) > 0.45) return { kind: 'puddle', obj: pd };
      if (d > 0.01) {
        const cos = ((pd.x - p.x) * lx + (pd.z - p.z) * lz) / d;
        if (cos > Math.cos(1.0)) return { kind: 'puddle', obj: pd };
      }
    }
  }
  return null;
}

export const environmentSystem = {
  geo(level) {
    return levelGeo(this.game.map, level, this.game.doorStr);
  },

  setDoor(i, ch) {
    const g = this.game;
    g.doorStr = g.doorStr.slice(0, i) + ch + g.doorStr.slice(i + 1);
  },

  buildVentLinks(map) {
    const links = new Map(map.vents.map((v) => [v.id, []]));
    for (const d of map.ducts) {
      links.get(d.a).push(d.b);
      links.get(d.b).push(d.a);
    }
    return links;
  },

  /** After moving: follow ramps between floors. */
  applyStairs(p) {
    p.level = resolveStairs(this.game.map, p.x, p.z, p.level);
  },

  // ---------------------------------------------------------------- generic "F" interaction
  interact(id, now = Date.now()) {
    const p = this.players.get(id);
    const g = this.game;
    if (!p || !g || this.phase !== 'playing' || !p.alive) return { ok: false };
    if (p.watching) {
      this.stopWatching(p, 'manual');
      return { ok: true, type: 'monitor' };
    }
    if (p.vent) return this.exitVent(p, now);
    if (p.inLocker !== null) return this.exitLocker(p, now);
    const it = findInteractable(g.map, p.x, p.z, p.level, { lockerOcc: g.lockerOcc });
    if (!it) return { ok: false, msg: 'Nothing to use here' };
    switch (it.type) {
      case 'monitor': return this.startWatching(p, now);
      case 'vent': return this.enterVent(p, it.obj, now);
      case 'locker': return this.enterLocker(p, it.obj, now);
      case 'switch': return this.toggleSwitch(p, it.obj);
      default: return { ok: false };
    }
  },

  /** Used by bots: toggle the nearest free locker / wardrobe. */
  toggleLocker(id, now = Date.now()) {
    const p = this.players.get(id);
    const g = this.game;
    if (!p || !g || this.phase !== 'playing' || !p.alive) return false;
    if (p.inLocker !== null) return this.exitLocker(p, now).ok;
    let best = null;
    let bd = 1.8;
    for (const l of g.map.lockers) {
      if (l.level !== p.level || g.lockerOcc.has(l.id)) continue;
      const d = dist2D(p.x, p.z, l.exitX, l.exitZ);
      if (d <= bd) {
        bd = d;
        best = l;
      }
    }
    if (!best) return false;
    return this.enterLocker(p, best, now).ok;
  },

  // ---------------------------------------------------------------- automatic doors
  doorBlocked(d) {
    for (const q of this.players.values()) {
      if (!q.alive || q.level !== d.level || q.vent) continue;
      if (pushOutOfBox(q.x, q.z, PLAYER_RADIUS, d)) return true;
    }
    return false;
  },

  openDoor(d, now) {
    if (this.game.doorStr[d.id] !== '0') return;
    this.setDoor(d.id, '1');
    this.game.doorSeen.set(d.id, now);
    this.broadcast('fx:door', { id: d.id, open: true });
  },

  /** Open any closed (unlocked) door right next to this player - called before moving so walking into a door never stops you. */
  autoOpenNear(p, now = Date.now()) {
    if (!p.alive || p.vent) return;
    for (const d of this.game.map.doors) {
      if (d.level !== p.level || this.game.doorStr[d.id] !== '0') continue;
      const [cx, cz] = doorCenter(d);
      if (dist2D(p.x, p.z, cx, cz) <= DOOR_OPEN_RANGE) this.openDoor(d, now);
    }
  },

  /** Doors open when someone walks up, and close again a moment after everyone has passed. */
  updateDoors(now) {
    const g = this.game;
    const living = [...this.players.values()].filter((q) => q.alive && !q.vent);
    for (const d of g.map.doors) {
      const st = g.doorStr[d.id];
      if (st === '2' || d.unsealed) continue;
      const [cx, cz] = doorCenter(d);
      let near = false;
      let close = false;
      for (const q of living) {
        if (q.level !== d.level) continue;
        const dd = dist2D(q.x, q.z, cx, cz);
        if (dd <= DOOR_CLOSE_RANGE) near = true;
        if (dd <= DOOR_OPEN_RANGE) close = true;
      }
      if (close && st === '0') this.openDoor(d, now);
      if (near) g.doorSeen.set(d.id, now);
      else if (st === '1' && now - (g.doorSeen.get(d.id) ?? 0) > DOOR_CLOSE_DELAY && !this.doorBlocked(d)) {
        this.setDoor(d.id, '0');
        this.broadcast('fx:door', { id: d.id, open: false });
      }
    }
  },

  /** Master Key: a sealed door opens and stays open for the rest of the round. */
  unlockDoor(d) {
    d.unsealed = true;
    this.setDoor(d.id, '1');
    this.broadcast('fx:door', { id: d.id, open: true, unsealed: true });
  },

  reply(p, res) {
    this.send(p.id, 'interact', res);
    return res;
  },

  // ---------------------------------------------------------------- lights
  toggleSwitch(p, s) {
    const g = this.game;
    const room = g.map.rooms[s.roomId];
    if (!room) return { ok: false };
    const on = g.lightStr[room.id] === '1';
    g.lightStr = g.lightStr.slice(0, room.id) + (on ? '0' : '1') + g.lightStr.slice(room.id + 1);
    this.broadcast('fx:switch', { roomId: room.id, on: !on, x: s.x, z: s.z, level: s.level });
    return { ok: true, type: 'switch', on: !on };
  },

  // ---------------------------------------------------------------- lockers / wardrobes
  enterLocker(p, l, now) {
    const g = this.game;
    if (g.lockerOcc.has(l.id)) return { ok: false };
    g.lockerOcc.set(l.id, p.id);
    p.inLocker = l.id;
    p.x = l.x;
    p.z = l.z;
    p.yaw = l.yaw;
    p.crouch = false;
    p.stillSince = now;
    this.forcePosition(p);
    return { ok: true, type: 'locker' };
  },

  exitLocker(p, now) {
    const l = this.game.map.lockers[p.inLocker];
    this.releaseLocker(p);
    const pos = resolveCollisions(this.geo(p.level), l.exitX, l.exitZ, PLAYER_RADIUS);
    p.x = pos.x;
    p.z = pos.z;
    p.stillSince = now;
    p.lastMoveAt = now;
    this.forcePosition(p);
    return { ok: true, type: 'locker' };
  },

  releaseLocker(p) {
    if (p.inLocker !== null && p.inLocker !== undefined && this.game) this.game.lockerOcc.delete(p.inLocker);
    p.inLocker = null;
  },

  // ---------------------------------------------------------------- vents
  enterVent(p, v, now) {
    p.vent = { at: v.id, to: null, t: 0 };
    p.x = v.x;
    p.z = v.z;
    p.level = v.level;
    p.killboxOpen = false;
    p.crouch = true;
    p.stillSince = now;
    this.forcePosition(p);
    this.broadcast('fx:vent', { x: v.x, z: v.z, level: v.level });
    return { ok: true, type: 'vent' };
  },

  ventSelect(id, toId) {
    const p = this.players.get(id);
    if (!p || !p.vent || p.vent.to !== null) return false;
    const links = this.game.ventLinks.get(p.vent.at) || [];
    if (!links.includes(toId)) return false;
    p.vent.to = toId;
    p.vent.t = 0;
    return true;
  },

  updateVents(now, dt) {
    const g = this.game;
    for (const p of this.players.values()) {
      if (!p.alive || !p.vent || p.vent.to === null) continue;
      const a = g.map.vents[p.vent.at];
      const b = g.map.vents[p.vent.to];
      const len = Math.max(0.5, dist2D(a.x, a.z, b.x, b.z));
      const input = p.isBot ? 1 : p.ventInput;
      if (!input) continue;
      p.vent.t += (input * VENT_SPEED * dt) / len;
      p.lastMoveAt = now;
      p.stillSince = now;
      if (p.vent.t >= 1) {
        p.vent = { at: b.id, to: null, t: 0 };
        p.x = b.x;
        p.z = b.z;
        p.level = b.level;
      } else if (p.vent.t <= 0) {
        p.vent = { at: a.id, to: null, t: 0 };
        p.x = a.x;
        p.z = a.z;
      } else {
        p.x = a.x + (b.x - a.x) * p.vent.t;
        p.z = a.z + (b.z - a.z) * p.vent.t;
      }
    }
  },

  exitVent(p, now) {
    if (p.vent.to !== null) return this.reply(p, { ok: false, type: 'vent', msg: 'Crawl to a vent opening first' });
    const v = this.game.map.vents[p.vent.at];
    p.vent = null;
    p.crouch = false;
    p.level = v.level;
    const pos = resolveCollisions(this.geo(p.level), v.x, v.z, PLAYER_RADIUS);
    p.x = pos.x;
    p.z = pos.z;
    p.stillSince = now;
    p.lastMoveAt = now;
    this.forcePosition(p);
    this.broadcast('fx:vent', { x: v.x, z: v.z, level: v.level });
    return { ok: true, type: 'vent' };
  },

  // ---------------------------------------------------------------- security room
  startWatching(p, now) {
    const g = this.game;
    const sec = g.map.security;
    if (!sec) return { ok: false };
    if (g.watcherId && g.watcherId !== p.id) return this.reply(p, { ok: false, type: 'monitor', msg: 'Someone is already watching' });
    g.watcherId = p.id;
    p.watching = true;
    p.killboxOpen = false;
    p.x = sec.chair.x;
    p.z = sec.chair.z;
    p.yaw = sec.chair.yaw;
    p.crouch = false;
    p.stillSince = now;
    this.forcePosition(p);
    return { ok: true, type: 'monitor' };
  },

  stopWatching(p, reason = 'manual') {
    const g = this.game;
    if (!p.watching) return;
    p.watching = false;
    if (g.watcherId === p.id) g.watcherId = null;
    const m = g.map.security.monitor;
    const pos = resolveCollisions(this.geo(p.level), m.x, m.z, PLAYER_RADIUS);
    p.x = pos.x;
    p.z = pos.z;
    p.lastMoveAt = Date.now();
    this.forcePosition(p);
    this.send(p.id, 'watch:end', { reason });
  },

  // ---------------------------------------------------------------- reflections
  updateReflections(p, now) {
    if (now < p.nextReflectAt) return;
    p.nextReflectAt = now + REFLECT.INTERVAL;
    if (!p.alive || p.inLocker !== null || p.vent || p.watching || !p.code) return;
    const src = reflectionSource(this.game.map, p);
    if (!src) return;
    if (Math.random() >= REFLECT.CHANCE) return;
    const idx = Math.floor(Math.random() * 4);
    // Only ONE digit and its position is ever sent.
    this.send(p.id, 'glimpse', { digit: p.code[idx], pos: idx + 1, source: src.kind, ms: REFLECT.SHOW_MS });
  },

  // ---------------------------------------------------------------- lights out
  scheduleLightsOut(now) {
    const g = this.game;
    g.loSchedule = [];
    if (!this.settings.lightsOut) return;
    const count = Math.max(1, Math.min(3, g.map.lightsOuts || 1));
    const start = g.graceUntil + 20000;
    const end = g.graceUntil + Math.max(60000, this.roundLengthMs() * 0.8);
    for (let tries = 0; tries < 200 && g.loSchedule.length < count; tries++) {
      const t = rand(start, end);
      if (g.loSchedule.every((s) => Math.abs(s - t) > 30000)) g.loSchedule.push(t);
    }
    g.loSchedule.sort((a, b) => a - b);
  },

  updateLightsOut(now) {
    const g = this.game;
    const lo = g.lo;
    if (!lo.phase && g.loSchedule.length && now >= g.loSchedule[0] && now >= g.graceUntil) {
      g.loSchedule.shift();
      lo.phase = 'warn';
      lo.warnUntil = now + LIGHTS_OUT_WARNING;
      this.broadcast('announce', { type: 'lightsOutWarn', ms: LIGHTS_OUT_WARNING });
    } else if (lo.phase === 'warn' && now >= lo.warnUntil) {
      lo.phase = 'on';
      lo.until = now + rand(LIGHTS_OUT_MIN, LIGHTS_OUT_MAX);
      this.broadcast('announce', { type: 'lightsOut', ms: lo.until - now });
    } else if (lo.phase === 'on' && now >= lo.until) {
      lo.phase = null;
      this.broadcast('announce', { type: 'lightsOn' });
    }
  },

  triggerLightsOut(now) {
    this.game.loSchedule.unshift(now);
    this.updateLightsOut(now);
  },
};
