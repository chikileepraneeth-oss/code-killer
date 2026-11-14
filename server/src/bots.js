// Server-side bots. They see like a first-person player: only inside their view cone (VIEW_FOV), within
// the same distance / line-of-sight / darkness / hood rules, read through visibleCode() - and they turn
// their heads to look around. Kills, lockers and items go through the same Room methods human input uses.
import { CROUCH_MULT, KILLBOX_MULT, PLAYER_RADIUS, VIS, WALK_SPEED } from '../../shared/constants.js';
import { dist2D, hasLineOfSight, moveWithCollisions, pointInBox } from '../../shared/geometry.js';
import { isDarkSpot } from '../../shared/world.js';
import { findPath, randomWalkablePoint } from './nav.js';
import { inViewCone, visibleCode } from './visibility.js';

const rand = (a, b) => a + Math.random() * (b - a);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function initBot(bot) {
  bot.ai = {
    mode: 'idle',
    goal: null,
    path: null,
    nextRepath: 0,
    until: 0,
    mem: new Map(), // targetId -> [d0,d1,d2,d3] (null = unknown)
    attack: null,
    nextPerceive: 0,
    nextAttackAllowed: 0,
    nextItemThink: 0,
    stuckFor: 0,
    seen: [],
    chaseId: null,
    reaction: rand(2500, 4500), // ms it takes this bot to "type" a code
    graceDelay: rand(3000, 12000),
    skill: rand(0.6, 1),
    look: Math.random() * Math.PI * 2,
    moveYaw: 0,
    scanDir: Math.random() < 0.5 ? -1 : 1,
    nextScanFlip: 0,
    swayPhase: Math.random() * 10,
    stairPhase: null,
  };
  bot.yaw = bot.ai.look;
  bot.lookX = Math.sin(bot.ai.look);
  bot.lookZ = Math.cos(bot.ai.look);
}

export function perceive(room, bot, now) {
  const ai = bot.ai;
  const ctx = room.visCtx(now);
  const geo = room.geo(bot.level);
  ai.seen = [];
  for (const other of room.players.values()) {
    if (other === bot || !other.alive) {
      if (other !== bot) ai.mem.delete(other.id);
      continue;
    }
    const d = dist2D(bot.x, bot.z, other.x, other.z);
    const visible = other.level === bot.level && !bot.vent && !other.vent && d < VIS.FAR + 4 &&
      inViewCone(bot, other) && hasLineOfSight(geo, bot.x, bot.z, other.x, other.z);
    if (visible && other.shimmerUntil > now) ai.mem.delete(other.id); // saw their code change
    const c = visibleCode(bot, other, ctx, { cone: true });
    if (c) {
      const m = ai.mem.get(other.id) || [null, null, null, null];
      const close = d <= VIS.CLOSE;
      for (let i = 0; i < 4; i++) {
        if (c[i] === '?') continue;
        if (close) m[i] = c[i];
        else if (m[i] === null) m[i] = Math.random() < 0.15 * (1.3 - ai.skill) ? String((Number(c[i]) + 1 + Math.floor(Math.random() * 9)) % 10) : c[i];
      }
      ai.mem.set(other.id, m);
    }
    if (visible && !other.hidden && other.inLocker === null) ai.seen.push({ p: other, d });
  }
  ai.seen.sort((a, b) => a.d - b.d);
}

function knownFully(ai, id) {
  const m = ai.mem.get(id);
  return !!m && m.every((d) => d !== null);
}

function setGoal(ai, mode, goal, now) {
  ai.mode = mode;
  ai.goal = goal;
  ai.path = null;
  ai.nextRepath = now;
  ai.stairPhase = null;
}

function thinkItems(room, bot, now) {
  const ai = bot.ai;
  if (now < ai.nextItemThink) return null;
  ai.nextItemThink = now + 600;
  const g = room.game;
  const has = (id) => bot.inv.indexOf(id);
  const use = (slot) => room.useItem(bot.id, slot, now);
  const threat = ai.seen.find((s) => s.d < 7 && s.p.killboxOpen);
  const inDark = g.lo.phase === 'on' || isDarkSpot(g.map, bot.x, bot.z, bot.level, g.lightStr);
  let s;
  if (threat && (s = has('shuffle')) >= 0) return use(s);
  if ((s = has('flashlight')) >= 0 && inDark !== bot.flashlightOn) return use(s);
  if ((s = has('masterkey')) >= 0) {
    const d = g.map.doors.find((dd) => dd.level === bot.level && g.doorStr[dd.id] === '2' && dist2D(bot.x, bot.z, (dd.minX + dd.maxX) / 2, (dd.minZ + dd.maxZ) / 2) < 2.2);
    if (d) return use(s);
  }
  return null;
}

function decide(room, bot, now) {
  const ai = bot.ai;
  const g = room.game;
  const z = g.zone;
  const dCur = dist2D(bot.x, bot.z, z.x, z.z);
  const dNext = dist2D(bot.x, bot.z, z.toX, z.toZ);
  const zoneMs = room.zoneMsLeft(now);
  const urgent = now >= g.graceUntil - 3000 &&
    (dCur > z.r - 2.5 || (z.phase !== 'final' && dNext > z.toR - 1.5 && (z.phase === 'shrink' || zoneMs < 12000)));
  if (urgent) {
    if (ai.mode !== 'zone' || now >= ai.nextRepath + 2000) {
      const r = Math.max(0.5, Math.min(z.r, z.toR) * 0.5);
      const p = randomWalkablePoint(g.map, (q) => dist2D(q.x, q.z, z.toX, z.toZ) < r, 0) || { x: z.toX, z: z.toZ, level: 0 };
      setGoal(ai, 'zone', p, now);
    }
    return;
  }
  if (ai.mode === 'zone' && ai.goal) return;

  if (ai.mode === 'hide' && now < ai.until) {
    const threat = ai.seen.find((s) => s.d < 4);
    if (!threat || Math.random() < 0.7) return;
  }

  const bountyId = g.bounty?.id;
  const candidate = ai.seen.find((s) => s.p.id === bountyId && !knownFully(ai, s.p.id)) || ai.seen.find((s) => !knownFully(ai, s.p.id));
  if (candidate && now >= g.graceUntil - 5000) {
    if (ai.mode !== 'chase' || ai.chaseId !== candidate.p.id || now >= ai.nextRepath) {
      ai.chaseId = candidate.p.id;
      if (candidate.d > 4.5) setGoal(ai, 'chase', { x: candidate.p.x, z: candidate.p.z, level: candidate.p.level }, now);
      else {
        ai.mode = 'chase';
        ai.goal = null;
      }
      ai.nextRepath = now + 700;
    }
    return;
  }
  if (ai.mode === 'chase') {
    ai.mode = 'idle';
    ai.goal = null;
  }

  if (ai.mode !== 'pickup') {
    const wantsItem = bot.inv.includes(null);
    const pk = g.pickups.find((p) => p.level === bot.level && (p.type !== 'item' || wantsItem) && dist2D(bot.x, bot.z, p.x, p.z) < 14 &&
      hasLineOfSight(room.geo(bot.level), bot.x, bot.z, p.x, p.z));
    if (pk) {
      setGoal(ai, 'pickup', { x: pk.x, z: pk.z, level: pk.level, pickupId: pk.id }, now);
      return;
    }
  } else if (!g.pickups.some((p) => p.id === ai.goal?.pickupId)) {
    ai.mode = 'idle';
    ai.goal = null;
  }

  if (!ai.goal && now >= ai.until) {
    const roll = Math.random();
    const inZone = (q) => dist2D(q.x, q.z, z.x, z.z) < Math.max(2, z.r - 4);
    if (roll < 0.3) {
      const indoor = g.map.hideZones.map((h) => ({ x: (h.minX + h.maxX) / 2, z: (h.minZ + h.maxZ) / 2, level: h.level })).filter(inZone);
      const outdoor = g.map.bushes.map((b) => ({ x: b.x, z: b.z, level: 0 })).filter(inZone);
      const spots = indoor.length && (Math.random() < 0.6 || !outdoor.length) ? indoor : outdoor;
      if (spots.length) {
        setGoal(ai, 'bush', spots[Math.floor(Math.random() * spots.length)], now);
        return;
      }
    } else if (roll < 0.42) {
      const lockers = g.map.lockers.filter((l) => !g.lockerOcc.has(l.id) && inZone({ x: l.exitX, z: l.exitZ }));
      if (lockers.length) {
        const l = lockers[Math.floor(Math.random() * lockers.length)];
        setGoal(ai, 'locker', { x: l.exitX, z: l.exitZ, level: l.level }, now);
        return;
      }
    }
    const level = Math.random() < 0.25 ? g.map.levels[Math.floor(Math.random() * g.map.levels.length)] : 0;
    setGoal(ai, 'wander', randomWalkablePoint(g.map, inZone, level), now);
  }
}

function arrive(room, bot, now) {
  const ai = bot.ai;
  switch (ai.mode) {
    case 'bush':
      ai.mode = 'hide';
      ai.until = now + rand(5000, 11000);
      break;
    case 'locker':
      if (room.toggleLocker(bot.id, now)) {
        ai.mode = 'inLocker';
        ai.until = now + rand(5000, 12000);
      } else ai.mode = 'idle';
      break;
    case 'chase':
      break;
    default:
      ai.mode = 'idle';
      ai.until = now + rand(300, 1500);
  }
  ai.goal = null;
  ai.path = null;
}

function lockedDoorAhead(room, bot, dirX, dirZ) {
  const g = room.game;
  for (const d of g.map.doors) {
    if (d.level !== bot.level || g.doorStr[d.id] !== '2') continue;
    const cx = (d.minX + d.maxX) / 2;
    const cz = (d.minZ + d.maxZ) / 2;
    if (dist2D(bot.x, bot.z, cx, cz) > 1.5) continue;
    if ((cx - bot.x) * dirX + (cz - bot.z) * dirZ >= -0.2) return true;
  }
  return false;
}

function step(room, bot, wp, now, dt) {
  const ai = bot.ai;
  const dx = wp.x - bot.x;
  const dz = wp.z - bot.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return { moved: 0, step: 0, locked: false };
  const locked = lockedDoorAhead(room, bot, dx / d, dz / d);
  bot.crouch = ai.mode === 'chase' && ai.seen.length > 0 && ai.seen[0].d < 10;
  const speed = WALK_SPEED * 0.92 * (bot.crouch ? CROUCH_MULT : 1) * (bot.killboxOpen ? KILLBOX_MULT : 1);
  const st = Math.min(d, speed * dt);
  room.autoOpenNear(bot, now);
  const np = moveWithCollisions(room.geo(bot.level), bot.x, bot.z, (dx / d) * st, (dz / d) * st, PLAYER_RADIUS);
  const moved = Math.hypot(np.x - bot.x, np.z - bot.z);
  bot.x = np.x;
  bot.z = np.z;
  room.applyStairs(bot);
  ai.moveYaw = Math.atan2(dx, dz);
  if (moved > 0.005) {
    bot.stillSince = now;
    bot.lastMoveAt = now;
  }
  return { moved, step: st, locked };
}

function move(room, bot, now, dt) {
  const ai = bot.ai;
  const map = room.game.map;
  if (!ai.goal) return;
  if (!ai.path || now >= ai.nextRepath) {
    // At most a few path searches per tick across all bots (a bot without a path just waits a tick)
    if (room.pathBudget > 0) {
      room.pathBudget--;
      ai.path = findPath(map, { x: bot.x, z: bot.z, level: bot.level }, ai.goal) || [];
      ai.nextRepath = now + (ai.mode === 'chase' ? 700 : 4000);
    }
  }
  if (!ai.path) return; // waiting for a path-search slot
  const goalLevel = ai.goal.level ?? 0;
  const arriveDist = ai.mode === 'chase' ? 4.5 : ai.mode === 'bush' ? 0.5 : 0.6;
  if (goalLevel === bot.level && dist2D(bot.x, bot.z, ai.goal.x, ai.goal.z) <= arriveDist) {
    arrive(room, bot, now);
    return;
  }
  let wp = ai.path[0];
  while (wp && wp.level === bot.level && wp.stair === undefined && dist2D(bot.x, bot.z, wp.x, wp.z) < 0.35) {
    ai.path.shift();
    wp = ai.path[0];
  }
  // Taking the stairs: walk to the near end of the ramp, then straight along it to the far end
  if (wp && wp.stair !== undefined) {
    const s = map.stairs[wp.stair];
    if (wp.level === bot.level && !pointInBox(bot.x, bot.z, s)) {
      ai.path.shift();
      ai.stairPhase = null;
      return;
    }
    const goingUp = wp.level === s.to;
    const near = goingUp ? s.a : s.b;
    const far = goingUp ? s.b : s.a;
    const onRamp = pointInBox(bot.x, bot.z, s);
    if (!onRamp && ai.stairPhase !== 'climb' && dist2D(bot.x, bot.z, near.x, near.z) > 0.3) wp = { x: near.x, z: near.z, level: bot.level };
    else {
      ai.stairPhase = 'climb';
      wp = { x: far.x, z: far.z, level: bot.level };
    }
  }
  if (!wp) wp = goalLevel === bot.level ? ai.goal : null;
  if (!wp) {
    ai.path = null;
    ai.nextRepath = now + 300;
    ai.stuckFor += dt;
    if (ai.stuckFor > 1.5) {
      ai.stuckFor = 0;
      setGoal(ai, 'wander', randomWalkablePoint(map, null, bot.level), now);
    }
    return;
  }
  const r = step(room, bot, wp, now, dt);
  if (r.moved < r.step * 0.3) {
    ai.stuckFor += dt;
    if (ai.stuckFor > (r.locked ? 0.4 : 0.9)) {
      ai.stuckFor = 0;
      ai.path = null;
      ai.nextRepath = now;
      ai.stairPhase = null;
      if (r.locked || Math.random() < 0.5) setGoal(ai, 'wander', randomWalkablePoint(map, null, bot.level), now);
    }
  } else ai.stuckFor = 0;
}

/** Where the bot looks: at its target, along its path with a little sway, or sweeping the room when still. */
function updateLook(bot, now, dt) {
  const ai = bot.ai;
  let target;
  const focus = ai.seen[0];
  if (ai.attack && ai.attack.target) target = Math.atan2(ai.attack.target.x - bot.x, ai.attack.target.z - bot.z);
  if (target === undefined && focus && (ai.mode === 'chase' || focus.d < 6)) target = Math.atan2(focus.p.x - bot.x, focus.p.z - bot.z);
  if (target === undefined && now - bot.lastMoveAt < 300) {
    ai.swayPhase += dt;
    target = ai.moveYaw + Math.sin(ai.swayPhase * 0.9) * 0.55;
  }
  if (target === undefined) {
    if (now >= ai.nextScanFlip) {
      ai.scanDir = -ai.scanDir;
      ai.nextScanFlip = now + rand(1500, 3500);
    }
    target = ai.look + ai.scanDir * 1.2 * dt * 4;
  }
  const diff = wrap(target - ai.look);
  const maxTurn = 4.5 * dt;
  ai.look = wrap(ai.look + Math.max(-maxTurn, Math.min(maxTurn, diff)));
  bot.yaw = ai.look;
  bot.lookX = Math.sin(ai.look);
  bot.lookZ = Math.cos(ai.look);
}

export function updateBot(room, bot, now, dt) {
  const ai = bot.ai;
  const g = room.game;
  if (!bot.alive || !g) return;

  if (now >= ai.nextPerceive) {
    ai.nextPerceive = now + 200;
    perceive(room, bot, now);
  }
  thinkItems(room, bot, now);
  if (!bot.alive) return;

  if (ai.attack) {
    const t = room.players.get(ai.attack.targetId);
    ai.attack.target = t;
    if (!t || !t.alive) {
      room.setKillbox(bot.id, false);
      ai.attack = null;
    } else if (!bot.killboxOpen) {
      ai.attack = null;
      ai.nextAttackAllowed = now + rand(1500, 3000);
    } else if (now >= ai.attack.at) {
      const res = room.attemptKill(bot.id, ai.attack.code, now);
      if (res.reason === 'rate_limited' || res.reason === 'locked') {
        ai.attack.at = now + 600;
      } else {
        if (!res.ok) ai.mem.delete(ai.attack.targetId);
        room.setKillbox(bot.id, false);
        ai.attack = null;
        ai.nextAttackAllowed = now + rand(3000, 8000);
      }
      if (!bot.alive) return;
    }
  } else if (now >= g.graceUntil + ai.graceDelay && now >= ai.nextAttackAllowed && now >= bot.lockoutUntil) {
    const bountyId = g.bounty?.id;
    const order = [...ai.mem.keys()].sort((a, b) => (a === bountyId ? -1 : b === bountyId ? 1 : 0));
    for (const tid of order) {
      const digits = ai.mem.get(tid);
      const t = room.players.get(tid);
      if (!t || !t.alive) {
        ai.mem.delete(tid);
        continue;
      }
      if (digits.every((d) => d !== null)) {
        room.setKillbox(bot.id, true);
        if (bot.killboxOpen) ai.attack = { code: digits.join(''), targetId: tid, target: t, at: now + ai.reaction * rand(0.7, 1.3) / ai.skill };
        else ai.nextAttackAllowed = now + 1500;
        break;
      }
    }
  }

  if (bot.inLocker !== null) {
    if (now >= ai.until && !ai.attack) {
      room.toggleLocker(bot.id, now);
      ai.mode = 'idle';
      ai.goal = null;
    }
    return;
  }
  if (bot.vent || bot.watching) {
    room.interact(bot.id, now);
    return;
  }

  decide(room, bot, now);
  move(room, bot, now, dt);
  updateLook(bot, now, dt);
}
