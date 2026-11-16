import {
  BOT_NAMES, CROUCH_MULT, DEFAULT_SETTINGS, GHOST_SPEED, HIDE_STILL_MS, KILLBOX_MULT, KILL_RATE, LEVEL_HEIGHT,
  CODE_STYLES, MAX_HEALTH, PENALTY_TYPES, PLAYER_COLORS, PLAYER_RADIUS, SETTINGS_LIMITS, SHIMMER_DURATION, WALK_SPEED,
  ZONE_DAMAGE, ZONE_FRACTIONS, ZONE_PRESETS, ZONE_SPEEDS, zoneStartRadius, zoneTimeScale,
} from '../../shared/constants.js';
import { clamp, dist2D, moveWithCollisions, resolveCollisions } from '../../shared/geometry.js';
import { generateMap } from '../../shared/mapgen.js';
import { defaultDoorState, defaultLightState, hideSpotAt, isDarkSpot, prepareMap } from '../../shared/world.js';
import { initBot, updateBot } from './bots.js';
import { generateSecretCode, isValidCodeGuess } from './codes.js';
import { getNavGrid, randomWalkablePoint } from './nav.js';
import { bountySystem } from './systems/bounty.js';
import { environmentSystem } from './systems/environment.js';
import { itemSystem } from './systems/items.js';
import { makeCtx, mergeCodes, visibleCode } from './visibility.js';

export class RoomError extends Error {}

const r2 = (v) => Math.round(v * 100) / 100;
const rand = (a, b) => a + Math.random() * (b - a);

export function sanitizeName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player';
}

export function sanitizeChat(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 140);
}

export function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Room {
  /**
   * @param {string} code 6-char room code
   * @param {{send:(playerId:string, event:string, data:any)=>void}} transport
   */
  constructor(code, transport) {
    this.code = code;
    this.transport = transport;
    this.players = new Map();
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.phase = 'lobby';
    this.game = null;
    this.botCounter = 0;
  }

  // ------------------------------------------------------------------ messaging
  send(playerId, event, data) {
    const p = this.players.get(playerId);
    if (p && !p.isBot) this.transport.send(playerId, event, data);
  }

  broadcast(event, data, filter = null) {
    if (this.tickEvents && event !== 'snap') this.tickEvents.push(event);
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (filter && !filter(p)) continue;
      this.transport.send(p.id, event, data);
    }
  }

  lobbyState() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, isBot: p.isBot, isHost: p.id === this.hostId,
      })),
    };
  }

  broadcastLobby() {
    this.broadcast('room:state', this.lobbyState());
  }

  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  // ------------------------------------------------------------------ lobby
  addPlayer({ id, name, isBot = false }, now = Date.now()) {
    if (this.players.has(id)) throw new RoomError('Already in room');
    if (this.players.size >= this.settings.maxPlayers) throw new RoomError('Room is full');
    let clean = sanitizeName(name);
    const names = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (names.has(clean.toLowerCase())) {
      let i = 2;
      while (names.has(`${clean}${i}`.toLowerCase())) i++;
      clean = `${clean.slice(0, 14)}${i}`;
    }
    const usedColors = new Set([...this.players.values()].map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !usedColors.has(c)) || PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
    const p = {
      id, name: clean, color, isBot, joinedAt: now,
      alive: false, spectator: false, code: null,
      x: 0, y: 0, z: 0, yaw: 0, level: 0,
    };
    this.players.set(id, p);
    if (!this.hostId && !isBot) this.hostId = id;

    if (this.phase === 'playing' && this.game) {
      // Late joiner: spectate as a ghost until the next round
      this.resetPlayerForGame(p, { x: 0, z: 0 }, null, now);
      p.alive = false;
      p.spectator = true;
      p.y = 12;
      if (isBot) initBot(p);
      this.send(id, 'game:start', this.gameStartPayload(p));
    }
    this.broadcastLobby();
    return p;
  }

  removePlayer(id, now = Date.now()) {
    const p = this.players.get(id);
    if (!p) return this.humanCount();
    if (this.phase === 'playing' && this.game && p.alive) this.eliminate(p, 'left', null, now);
    if (this.game) {
      this.releaseLocker(p);
      if (this.game.watcherId === p.id) this.game.watcherId = null;
    }
    this.players.delete(id);
    if (this.hostId === id) {
      const next = [...this.players.values()].find((q) => !q.isBot);
      this.hostId = next ? next.id : null;
    }
    if (this.phase === 'playing' && this.game) this.checkWin(now);
    this.broadcastLobby();
    return this.humanCount();
  }

  requireHost(byId) {
    if (byId !== this.hostId) throw new RoomError('Only the host can do that');
  }

  requireLobby() {
    if (this.phase !== 'lobby') throw new RoomError('Game in progress');
  }

  updateSettings(byId, patch = {}) {
    this.requireHost(byId);
    this.requireLobby();
    const s = { ...this.settings };
    const int = (key) => {
      if (patch[key] === undefined) return;
      const v = Math.round(Number(patch[key]));
      if (!Number.isFinite(v)) return;
      const [lo, hi] = SETTINGS_LIMITS[key];
      s[key] = clamp(v, lo, hi);
    };
    if (PENALTY_TYPES.includes(patch.penaltyType)) s.penaltyType = patch.penaltyType;
    if (ZONE_SPEEDS.includes(patch.zoneSpeed)) s.zoneSpeed = patch.zoneSpeed;
    if (typeof patch.lightsOut === 'boolean') s.lightsOut = patch.lightsOut;
    if (CODE_STYLES.includes(patch.codeStyle)) s.codeStyle = patch.codeStyle;
    ['maxPlayers', 'lockoutSeconds', 'revealSeconds', 'deathAfter', 'graceSeconds'].forEach(int);
    s.maxPlayers = Math.max(s.maxPlayers, this.players.size);
    this.settings = s;
    this.broadcastLobby();
    return s;
  }

  addBot(byId) {
    this.requireHost(byId);
    this.requireLobby();
    if (this.players.size >= this.settings.maxPlayers) throw new RoomError('Room is full');
    const used = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot${this.botCounter + 1}`;
    const id = `bot_${this.code}_${++this.botCounter}`;
    return this.addPlayer({ id, name, isBot: true });
  }

  removeBot(byId) {
    this.requireHost(byId);
    this.requireLobby();
    const bots = [...this.players.values()].filter((p) => p.isBot);
    if (!bots.length) throw new RoomError('No bots to remove');
    this.removePlayer(bots[bots.length - 1].id);
  }

  // ------------------------------------------------------------------ game setup
  resetPlayerForGame(p, spawn, code, now) {
    Object.assign(p, {
      alive: true, spectator: false, code,
      x: spawn.x, y: 0, z: spawn.z, level: 0, yaw: Math.random() * Math.PI * 2,
      lookX: 0, lookZ: 1, viewPitch: 0.3,
      health: MAX_HEALTH, kills: 0, wrongGuesses: 0, diedAt: null, killedBy: null,
      crouch: false, killboxOpen: false, inLocker: null, vent: null, ventInput: 0, watching: false,
      lockoutUntil: 0, revealedUntil: 0, hoodUntil: 0, hoodDigits: null, shimmerUntil: 0,
      stillSince: now, lastMoveAt: 0, hidden: false, outsideZone: false,
      budget: 0, budgetAt: now, lastCorrectionAt: 0,
      killTokens: KILL_RATE.CAPACITY, killTokensAt: now, lastKillAt: -Infinity,
      lastChatAt: 0,
      inv: [null, null], flashlightOn: false, nextReflectAt: now + 5000, pendingReward: null,
      noPickupUntil: 0, fullMsgAt: 0, bountiesClaimed: 0, itemsUsed: 0,
    });
    p.yaw = Math.atan2(-spawn.x, -spawn.z) || 0;
    p.lookX = Math.sin(p.yaw);
    p.lookZ = Math.cos(p.yaw);
  }

  /** Map for this round: always the village. Tests can set `room.mapOverride` to a prepared map. */
  buildMap() {
    if (this.mapOverride) return this.mapOverride;
    return prepareMap(generateMap());
  }

  start(byId, now = Date.now(), { seed = (Math.random() * 2 ** 31) >>> 0 } = {}) {
    this.requireHost(byId);
    this.requireLobby();
    if (this.players.size < 2) throw new RoomError('Need at least 2 players');
    const map = this.buildMap(seed);
    getNavGrid(map); // build (or reuse) the bot nav grid now, not inside the first game tick
    this.pathBudget = 3;
    // Small games start with a smaller zone, so only spawn points inside it are used.
    const startR = this.mapOverride && !this.mapOverride.useZoneScaling ? map.size * 0.74 : zoneStartRadius(this.players.size);
    const inZone = map.spawns.filter((sp) => Math.hypot(sp.x, sp.z) <= startR - 3);
    const spawns = shuffled(inZone.length >= Math.min(this.players.size, map.spawns.length) ? inZone : map.spawns);
    const used = new Set();
    let i = 0;
    for (const p of this.players.values()) {
      const code = generateSecretCode(used);
      used.add(code);
      const sp = spawns[i % spawns.length];
      const pos = i >= spawns.length ? resolveCollisions(map.static[0] ? { ...map.static[0], size: map.size } : map, sp.x + rand(-1, 1), sp.z + rand(-1, 1), PLAYER_RADIUS) : sp;
      i++;
      this.resetPlayerForGame(p, pos, code, now);
      if (p.isBot) initBot(p);
    }
    const graceUntil = now + this.settings.graceSeconds * 1000;
    const R = ZONE_FRACTIONS.map((f) => +(f * startR).toFixed(2));
    this.game = {
      map,
      startedAt: now,
      graceUntil,
      lastTick: now,
      zoneRadii: R,
      zoneScale: zoneTimeScale(startR),
      zone: { stage: 0, phase: 'wait', phaseStart: graceUntil, x: 0, z: 0, r: R[0], fromX: 0, fromZ: 0, fromR: R[0], toX: 0, toZ: 0, toR: R[1] },
      doorStr: defaultDoorState(map),
      doorSeen: new Map(),
      lightStr: defaultLightState(map),
      pickups: [],
      nextPickupId: 1,
      nextSpawn: { hood: now + 9000, item: now + 2000 },
      lockerOcc: new Map(),
      ventLinks: this.buildVentLinks(map),
      watcherId: null,
      bounty: null,
      lastBountyId: null,
      nextBountyAt: graceUntil + 60000,
      lo: { phase: null, warnUntil: 0, until: 0 },
      loSchedule: [],
      deathOrder: [],
      ended: false,
    };
    getNavGrid(map); // build up-front (bots + zone placement) instead of hitching mid-round
    this.pickNextZone();
    this.scheduleLightsOut(now);
    // A few items on the ground from the start
    for (let k = 0; k < Math.ceil(map.itemCount / 2); k++) this.spawnItem(now);
    this.phase = 'playing';
    for (const p of this.players.values()) this.send(p.id, 'game:start', this.gameStartPayload(p));
    this.broadcastLobby();
  }

  gameStartPayload(p) {
    return {
      map: this.game.map,
      selfId: p.id,
      spectator: !!p.spectator,
      spawn: { x: p.x, z: p.z, yaw: p.yaw, level: p.level ?? 0 },
      settings: this.settings,
      graceMs: Math.max(0, this.game.graceUntil - Date.now()),
      players: [...this.players.values()].map((q) => ({ id: q.id, name: q.name, color: q.color, isBot: q.isBot })),
    };
  }

  // ------------------------------------------------------------------ zone (scaled by map size)
  zonePreset() {
    const base = ZONE_PRESETS[this.settings.zoneSpeed] || ZONE_PRESETS.normal;
    const k = this.game.zoneScale;
    return { wait: base.wait.map((v) => v * k), shrink: base.shrink.map((v) => v * k) };
  }

  pickNextZone() {
    const g = this.game;
    const z = g.zone;
    const nextR = g.zoneRadii[z.stage + 1];
    if (nextR === undefined) return;
    const maxOff = Math.max(0, z.r - nextR);
    const lim = g.map.size / 2 - 3 - nextR * 0.5;
    const p = randomWalkablePoint(g.map, (q) =>
      dist2D(q.x, q.z, z.x, z.z) <= maxOff * 0.7 && Math.abs(q.x) <= Math.max(lim, 2) && Math.abs(q.z) <= Math.max(lim, 2));
    z.toX = p.x;
    z.toZ = p.z;
    z.toR = nextR;
  }

  updateZone(now) {
    const g = this.game;
    const z = g.zone;
    if (now < g.graceUntil || z.phase === 'final') return;
    const preset = this.zonePreset();
    if (z.phase === 'wait' && now - z.phaseStart >= preset.wait[z.stage] * 1000) {
      z.phase = 'shrink';
      z.phaseStart = now;
      z.fromX = z.x; z.fromZ = z.z; z.fromR = z.r;
      this.broadcast('announce', { type: 'zoneShrink', stage: z.stage + 1 });
    }
    if (z.phase === 'shrink') {
      const t = Math.min(1, (now - z.phaseStart) / (preset.shrink[z.stage] * 1000));
      z.x = z.fromX + (z.toX - z.fromX) * t;
      z.z = z.fromZ + (z.toZ - z.fromZ) * t;
      z.r = z.fromR + (z.toR - z.fromR) * t;
      if (t >= 1) {
        z.stage++;
        z.phaseStart = now;
        if (z.stage >= g.zoneRadii.length - 1) z.phase = 'final';
        else {
          z.phase = 'wait';
          this.pickNextZone();
        }
      }
    }
  }

  zoneMsLeft(now) {
    const g = this.game;
    const z = g.zone;
    if (now < g.graceUntil) return g.graceUntil - now;
    if (z.phase === 'final') return 0;
    const preset = this.zonePreset();
    const dur = (z.phase === 'wait' ? preset.wait[z.stage] : preset.shrink[z.stage]) * 1000;
    return Math.max(0, z.phaseStart + dur - now);
  }

  roundLengthMs() {
    const p = this.zonePreset();
    return (p.wait.reduce((a, b) => a + b, 0) + p.shrink.reduce((a, b) => a + b, 0)) * 1000;
  }

  // ------------------------------------------------------------------ movement
  handleMove(id, msg, now = Date.now()) {
    const p = this.players.get(id);
    const g = this.game;
    if (!p || p.isBot || this.phase !== 'playing' || !g || !msg || typeof msg !== 'object') return;
    const x = Number(msg.x);
    const z = Number(msg.z);
    const yaw = Number(msg.yaw);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (Number.isFinite(yaw)) p.yaw = yaw % (Math.PI * 2);
    const vy = Number(msg.vy);
    if (Number.isFinite(vy)) {
      p.lookX = -Math.sin(vy);
      p.lookZ = -Math.cos(vy);
    }
    const vp = Number(msg.vp);
    if (Number.isFinite(vp)) p.viewPitch = clamp(vp, -1.5, 1.5);
    p.ventInput = clamp(Math.round(Number(msg.vf) || 0), -1, 1);

    if (!p.alive) {
      // Ghost: free flight, still speed-limited, no collisions
      const y = Number.isFinite(Number(msg.y)) ? Number(msg.y) : p.y;
      this.refillBudget(p, GHOST_SPEED, now);
      let dx = x - p.x, dy = y - p.y, dz = z - p.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > p.budget) {
        const s = p.budget / d;
        dx *= s; dy *= s; dz *= s;
      }
      p.budget -= Math.min(d, p.budget);
      const lim = g.map.size / 2 + 4;
      p.x = clamp(p.x + dx, -lim, lim);
      p.y = clamp(p.y + dy, -LEVEL_HEIGHT, 35);
      p.z = clamp(p.z + dz, -lim, lim);
      this.maybeCorrect(p, x, z, now, y);
      return;
    }

    // Can't walk while in a locker, a vent or the security chair
    if (p.inLocker !== null || p.vent || p.watching) return;
    p.crouch = !!msg.cr;
    const mult = (p.crouch ? CROUCH_MULT : 1) * (p.killboxOpen ? KILLBOX_MULT : 1);
    this.refillBudget(p, WALK_SPEED * mult, now);
    let dx = x - p.x;
    let dz = z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > p.budget) {
      const s = p.budget / d;
      dx *= s; dz *= s;
    }
    p.budget -= Math.min(d, p.budget);
    this.autoOpenNear(p, now);
    const np = moveWithCollisions(this.geo(p.level), p.x, p.z, dx, dz, PLAYER_RADIUS);
    const moved = Math.hypot(np.x - p.x, np.z - p.z);
    p.x = np.x;
    p.z = np.z;
    const lv = p.level;
    this.applyStairs(p);
    if (moved > 0.01) {
      p.stillSince = now;
      p.lastMoveAt = now;
    }
    const clientLevel = Number(msg.lv);
    if (Number.isFinite(clientLevel) && clientLevel !== p.level && now - p.lastCorrectionAt > 250) {
      p.lastCorrectionAt = now;
      this.send(p.id, 'correct', { x: r2(p.x), y: r2(p.y), z: r2(p.z), level: p.level });
    } else if (lv === p.level) this.maybeCorrect(p, x, z, now);
  }

  refillBudget(p, speed, now) {
    const elapsed = Math.max(0, now - p.budgetAt);
    p.budgetAt = now;
    // 20% tolerance for jitter; cap so you can't "save up" a teleport
    p.budget = Math.min(p.budget + (speed * elapsed * 1.2) / 1000, speed * 0.5 + 0.25);
  }

  maybeCorrect(p, cx, cz, now, cy = null) {
    const err = Math.hypot(cx - p.x, cz - p.z, cy === null ? 0 : cy - p.y);
    if (err > 0.75 && now - p.lastCorrectionAt > 250) {
      p.lastCorrectionAt = now;
      this.send(p.id, 'correct', { x: r2(p.x), y: r2(p.y), z: r2(p.z), level: p.level });
    }
  }

  forcePosition(p) {
    p.budget = 0;
    p.budgetAt = Date.now();
    this.send(p.id, 'correct', { x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r2(p.yaw), level: p.level, force: true });
  }

  // ------------------------------------------------------------------ kills
  setKillbox(id, open) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'playing' || !p.alive) return;
    if (open && p.watching) this.stopWatching(p, 'killbox');
    p.killboxOpen = !!open;
  }

  takeKillToken(p, now) {
    if (now - p.lastKillAt < KILL_RATE.MIN_GAP_MS) return false;
    p.killTokens = Math.min(KILL_RATE.CAPACITY, p.killTokens + (now - p.killTokensAt) / KILL_RATE.REFILL_MS);
    p.killTokensAt = now;
    if (p.killTokens < 1) return false;
    p.killTokens -= 1;
    p.lastKillAt = now;
    return true;
  }

  /** Server-side kill validation. Returns { ok, reason, ... } and also notifies the attacker. */
  attemptKill(id, rawCode, now = Date.now()) {
    const res = this.resolveKill(id, rawCode, now);
    this.send(id, 'kill:result', res);
    const p = this.players.get(id);
    // Anyone watching cameras nearby gets startled out of the chair
    if (p && this.game && res.reason !== 'rate_limited' && res.reason !== 'not_allowed') {
      for (const q of this.players.values()) {
        if (q.watching && q.id !== id && q.level === p.level && dist2D(q.x, q.z, p.x, p.z) < 8) this.stopWatching(q, 'nearby');
      }
    }
    return res;
  }

  resolveKill(id, rawCode, now) {
    const p = this.players.get(id);
    const g = this.game;
    if (!p || this.phase !== 'playing' || !g || g.ended || !p.alive) return { ok: false, reason: 'not_allowed' };
    if (now < g.graceUntil) return { ok: false, reason: 'grace', ms: g.graceUntil - now };
    if (!p.killboxOpen) return { ok: false, reason: 'killbox_closed' };
    if (now < p.lockoutUntil) return { ok: false, reason: 'locked', ms: p.lockoutUntil - now };
    if (!this.takeKillToken(p, now)) return { ok: false, reason: 'rate_limited' };
    const code = typeof rawCode === 'string' ? rawCode.trim() : '';
    if (!isValidCodeGuess(code)) return { ok: false, reason: 'invalid' };

    let target = null;
    for (const q of this.players.values()) {
      if (q !== p && q.alive && q.code === code) {
        target = q;
        break;
      }
    }
    if (target) {
      if (target.watching) this.stopWatching(target, 'attacked');
      p.kills++;
      p.killboxOpen = false;
      this.eliminate(target, 'kill', p, now);
      return { ok: true, victim: target.name, victimColor: target.color };
    }

    // Wrong guess (includes typing your own code - indistinguishable on purpose)
    p.wrongGuesses++;
    const s = this.settings;
    const res = { ok: false, reason: 'wrong', penalty: s.penaltyType, wrongGuesses: p.wrongGuesses };
    if (s.penaltyType === 'lockout') {
      p.lockoutUntil = now + s.lockoutSeconds * 1000;
      res.ms = s.lockoutSeconds * 1000;
    } else if (s.penaltyType === 'reveal') {
      p.revealedUntil = now + s.revealSeconds * 1000;
      p.lockoutUntil = now + 1000;
      res.ms = 1000;
      res.revealMs = s.revealSeconds * 1000;
    } else if (s.penaltyType === 'death') {
      res.guessesLeft = Math.max(0, s.deathAfter - p.wrongGuesses);
      if (p.wrongGuesses >= s.deathAfter) {
        p.killboxOpen = false;
        this.eliminate(p, 'guesses', null, now);
        res.died = true;
      } else {
        p.lockoutUntil = now + 1000;
        res.ms = 1000;
      }
    }
    return res;
  }

  shuffleCode(p, now) {
    const used = new Set();
    for (const q of this.players.values()) if (q.code) used.add(q.code);
    p.code = generateSecretCode(used); // `used` includes the old code, so it always changes
    p.shimmerUntil = now + SHIMMER_DURATION;
    this.send(p.id, 'you:codeChanged', {});
    this.broadcast('fx:shimmer', { id: p.id });
  }

  chat(id, raw, now = Date.now()) {
    const p = this.players.get(id);
    if (!p) return;
    const text = sanitizeChat(raw);
    if (!text) return;
    if (now - (p.lastChatAt || 0) < 500) return;
    p.lastChatAt = now;
    const ghost = this.phase === 'playing' && !p.alive;
    const msg = { name: p.name, color: p.color, text, ghost };
    // Ghosts can only talk to other ghosts; the living talk to everyone.
    this.broadcast('chat', msg, ghost ? (q) => !q.alive : null);
  }

  // ------------------------------------------------------------------ death & win
  eliminate(victim, cause, killer, now) {
    const g = this.game;
    if (!victim.alive) return;
    const wasBounty = g.bounty && g.bounty.id === victim.id;
    victim.alive = false;
    victim.diedAt = now;
    victim.killedBy = killer ? killer.id : null;
    victim.killboxOpen = false;
    this.releaseLocker(victim);
    if (victim.watching) {
      victim.watching = false;
      g.watcherId = null;
    }
    victim.vent = null;
    victim.flashlightOn = false;
    this.dropAllItems(victim, now);
    victim.y = victim.level * LEVEL_HEIGHT + 2.5;
    victim.budget = 0;
    victim.budgetAt = now;
    g.deathOrder.push(victim.id);
    const bountyClaim = wasBounty && cause === 'kill' && killer;
    this.broadcast('feed', {
      cause: bountyClaim ? 'bounty' : cause,
      killer: killer ? killer.name : null,
      killerColor: killer ? killer.color : null,
      killerId: killer ? killer.id : null,
      victim: victim.name,
      victimColor: victim.color,
      victimId: victim.id,
    });
    this.broadcast('fx:death', { id: victim.id, x: r2(victim.x), z: r2(victim.z), level: victim.level, color: victim.color });
    this.send(victim.id, 'you:died', {
      cause, by: killer ? killer.name : null, byId: killer ? killer.id : null, byColor: killer ? killer.color : null,
      survivedMs: now - g.startedAt, x: r2(victim.x), z: r2(victim.z),
    });
    if (wasBounty) this.onBountyEnded(victim, killer, cause, now);
    this.checkWin(now);
  }

  checkWin(now) {
    const g = this.game;
    if (!g || g.ended) return;
    const alive = [...this.players.values()].filter((p) => p.alive && !p.spectator);
    if (alive.length > 1) return;
    let winner = alive[0];
    if (!winner && g.deathOrder.length) winner = this.players.get(g.deathOrder[g.deathOrder.length - 1]);
    this.endGame(winner || null, now);
  }

  endGame(winner, now) {
    const g = this.game;
    g.ended = true;
    const participants = [...this.players.values()].filter((p) => !p.spectator && p.code);
    const order = [...g.deathOrder].reverse().filter((id) => !winner || id !== winner.id);
    const placeOf = (p) => (winner && p.id === winner.id ? 1 : (order.includes(p.id) ? order.indexOf(p.id) + 2 : participants.length));
    const stats = participants
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isBot: p.isBot,
        kills: p.kills,
        wrongGuesses: p.wrongGuesses,
        bounties: p.bountiesClaimed,
        itemsUsed: p.itemsUsed,
        survivedMs: (p.alive ? now : p.diedAt) - g.startedAt,
        code: p.code, // game is over: safe to reveal
        place: placeOf(p),
      }))
      .sort((a, b) => a.place - b.place);
    this.broadcast('game:over', {
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : null,
      winnerColor: winner ? winner.color : null,
      durationMs: now - g.startedAt,
      mapName: g.map.themeName,
      stats,
    });
    this.phase = 'lobby';
    this.game = null;
    for (const p of this.players.values()) {
      p.alive = false;
      p.spectator = false;
      p.code = null;
      p.inLocker = null;
      p.vent = null;
      p.watching = false;
      p.inv = [null, null];
    }
    this.broadcastLobby();
  }

  // ------------------------------------------------------------------ tick
  visCtx(now) {
    const g = this.game;
    return makeCtx(g.map, now, {
      lightsOut: g.lo.phase === 'on',
      doors: g.doorStr,
      lights: g.lightStr,
      faceOnly: this.settings.codeStyle === 'face',
    });
  }

  tick(now = Date.now()) {
    if (this.phase !== 'playing' || !this.game) return;
    const g = this.game;
    const dt = Math.min(0.2, Math.max(0, (now - g.lastTick) / 1000));
    g.lastTick = now;

    this.updateZone(now);
    this.updateLightsOut(now);
    this.updateDoors(now);
    this.updateBounty(now);
    this.updateVents(now, dt);

    // Bots think & move (pathfinding is budgeted per tick so it can't cause a lag spike)
    this.pathBudget = 3;
    for (const p of this.players.values()) {
      if (p.isBot && p.ai) updateBot(this, p, now, dt);
      if (g.ended) return;
    }

    // Per-player state
    const zone = g.zone;
    const dmg = ZONE_DAMAGE[Math.min(zone.stage, ZONE_DAMAGE.length - 1)] * dt;
    const zoneVictims = [];
    let aliveCount = 0;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      aliveCount++;
      const still = now - p.stillSince >= HIDE_STILL_MS;
      const spot = hideSpotAt(g.map, p.x, p.z, p.level) || isDarkSpot(g.map, p.x, p.z, p.level, g.lightStr);
      p.hidden = p.inLocker !== null || !!p.vent || (!!spot && still && !p.watching);
      if (p.hoodUntil && now >= p.hoodUntil) {
        p.hoodUntil = 0;
        p.hoodDigits = null;
      }
      this.collectPickups(p, now);
      if (!p.isBot) this.updateReflections(p, now);
      // Zone
      p.outsideZone = now >= g.graceUntil && dist2D(p.x, p.z, zone.x, zone.z) > zone.r;
      if (p.outsideZone) {
        const before = p.health;
        p.health -= dmg;
        if (p.watching) this.stopWatching(p, 'damage');
        if (p.health <= 0) zoneVictims.push({ p, before });
      }
    }
    if (zoneVictims.length) {
      if (zoneVictims.length >= aliveCount) {
        // Everyone left would die this tick: the healthiest survives
        zoneVictims.sort((a, b) => b.before - a.before);
        zoneVictims.shift().p.health = 1;
      }
      for (const { p } of zoneVictims) {
        this.eliminate(p, 'zone', null, now);
        if (g.ended) return;
      }
    }

    this.updatePickupSpawns(now, aliveCount);
    this.sendSnapshots(now);
  }

  updatePickupSpawns(now, aliveCount) {
    const g = this.game;
    const target = aliveCount >= 6 ? 2 : 1;
    const hoods = g.pickups.filter((p) => p.type === 'hood').length;
    if (hoods < target && now >= g.nextSpawn.hood) {
      this.spawnPickupAt('hood', null, now);
      g.nextSpawn.hood = now + rand(20000, 35000);
    }
    const items = g.pickups.filter((p) => p.type === 'item' && !p.dropped).length;
    if (items < g.map.itemCount && now >= g.nextSpawn.item) {
      this.spawnItem(now);
      g.nextSpawn.item = now + rand(12000, 25000) * (6 / (g.map.itemCount + 1));
    }
  }

  playerEntry(p, now) {
    const e = {
      id: p.id,
      x: r2(p.x),
      z: r2(p.z),
      yaw: r2(p.yaw),
      lv: p.level,
      cr: p.crouch ? 1 : 0,
      mv: now - p.lastMoveAt < 200 ? 1 : 0,
      h: p.hoodUntil > now ? 1 : 0,
      s: p.shimmerUntil > now ? 1 : 0,
      lk: p.inLocker !== null ? 1 : 0,
      rv: p.revealedUntil > now ? 1 : 0,
      kb: p.killboxOpen ? 1 : 0,
    };
    if (p.flashlightOn) {
      e.fl = 1;
      e.fy = r2(Math.atan2(p.lookX, p.lookZ));
    }
    if (p.vent) e.vt = 1;
    if (p.watching) e.wt = 1;
    return e;
  }

  buildSnapshot(viewer, now, ctx) {
    const g = this.game;
    const ps = [];
    const codes = {};
    const cams = viewer.watching && viewer.alive && g.map.security ? g.map.security.cameras : null;
    for (const p of this.players.values()) {
      if (!p.alive) {
        // Ghosts are only visible to other ghosts
        if (!viewer.alive && p.id !== viewer.id && !p.spectator) ps.push({ id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r2(p.yaw), g: 1 });
        continue;
      }
      ps.push(this.playerEntry(p, now));
      if (p.id !== viewer.id) {
        let c = visibleCode(viewer, p, ctx);
        if (cams) {
          for (const cam of cams) {
            const camViewer = { id: `cam${cam.id}`, alive: true, x: cam.x, z: cam.z, level: cam.level, lookX: Math.sin(cam.yaw), lookZ: Math.cos(cam.yaw), lensUntil: 0 };
            c = mergeCodes(c, visibleCode(camViewer, p, ctx));
          }
        }
        if (c) codes[p.id] = c;
      }
    }
    const z = g.zone;
    let alive = 0;
    for (const p of this.players.values()) if (p.alive) alive++;
    const ms = (t) => Math.max(0, Math.round(t - now));
    return {
      t: now,
      ps,
      codes,
      me: {
        alive: viewer.alive ? 1 : 0,
        hp: Math.max(0, Math.round(viewer.health || 0)),
        hidden: viewer.alive && viewer.hidden ? 1 : 0,
        lockMs: ms(viewer.lockoutUntil || 0),
        hoodMs: ms(viewer.hoodUntil || 0),
        revealMs: ms(viewer.revealedUntil || 0),
        wrong: viewer.wrongGuesses || 0,
        kills: viewer.kills || 0,
        kb: viewer.killboxOpen ? 1 : 0,
        lk: viewer.inLocker ?? null,
        out: viewer.outsideZone ? 1 : 0,
        lv: viewer.level ?? 0,
        inv: viewer.inv || [null, null],
        flash: viewer.flashlightOn ? 1 : 0,
        vent: viewer.vent ? { at: viewer.vent.at, to: viewer.vent.to, t: r2(viewer.vent.t), links: g.ventLinks.get(viewer.vent.at) || [] } : null,
        watch: viewer.watching ? 1 : 0,
        reward: viewer.pendingReward ? ms(viewer.pendingReward.until) : 0,
      },
      zone: {
        x: r2(z.x), z: r2(z.z), r: r2(z.r), tx: r2(z.toX), tz: r2(z.toZ), tr: r2(z.toR),
        stage: z.stage, phase: z.phase, ms: Math.round(this.zoneMsLeft(now)),
      },
      grace: Math.max(0, g.graceUntil - now),
      lo: g.lo.phase ? { phase: g.lo.phase, ms: ms(g.lo.phase === 'warn' ? g.lo.warnUntil : g.lo.until) } : null,
      bounty: g.bounty ? { id: g.bounty.id, ms: ms(g.bounty.until) } : null,
      alive,
      total: [...this.players.values()].filter((p) => !p.spectator && p.code).length,
    };
  }

  sendSnapshots(now) {
    const g = this.game;
    const ctx = this.visCtx(now);
    const pkKey = g.pickups.map((p) => `${p.id}`).join(',');
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      const snap = this.buildSnapshot(p, now, ctx);
      // Rarely-changing state is only sent when it changes (clients keep the last value).
      const sent = p._sent || (p._sent = {});
      if (sent.doors !== g.doorStr || sent.game !== g) snap.doors = sent.doors = g.doorStr;
      if (sent.lights !== g.lightStr || sent.game !== g) snap.lights = sent.lights = g.lightStr;
      if (sent.pk !== pkKey || sent.game !== g) {
        snap.pk = g.pickups;
        sent.pk = pkKey;
      }
      sent.game = g;
      this.transport.send(p.id, 'snap', snap);
    }
  }
}

Object.assign(Room.prototype, environmentSystem, itemSystem, bountySystem);
