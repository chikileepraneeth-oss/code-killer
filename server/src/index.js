import express from 'express';
import { PerformanceObserver } from 'node:perf_hooks';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { TICK_MS } from '../../shared/constants.js';
import { generateRoomCode, normalizeRoomCode } from './codes.js';
import { Room, RoomError } from './room.js';


/** Simple per-socket, per-event token bucket to stop event floods. */
function makeLimiter() {
  const buckets = new Map();
  return (event, perSecond, burst = perSecond) => {
    const now = Date.now();
    let b = buckets.get(event);
    if (!b) {
      b = { tokens: burst, at: now };
      buckets.set(event, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// Spike logger: any server tick > 50 ms (and GC pauses > 20 ms, and client frame spikes) with context.
// ---------------------------------------------------------------------------------------------
const spikes = [];
let lastGc = null;
function recordSpike(entry) {
  spikes.push({ at: new Date().toISOString(), ...entry });
  if (spikes.length > 300) spikes.shift();
  if (process.env.CK_QUIET_SPIKES !== '1') console.warn('[spike]', JSON.stringify(entry));
}
function sanitizeSpike(info) {
  if (!info || typeof info !== 'object') return {};
  const out = {};
  for (const k of ['frameMs', 'workMs', 'events', 'programs', 'newPrograms', 'geometries', 'textures', 'drawCalls', 'heapMB', 'players', 'nearby', 'phase', 'longTask']) {
    if (info[k] === undefined) continue;
    out[k] = typeof info[k] === 'number' ? Math.round(info[k] * 10) / 10 : String(info[k]).slice(0, 200);
  }
  return out;
}
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      lastGc = { at: Date.now(), ms: e.duration };
      if (e.duration > 20) recordSpike({ side: 'server', kind: 'gc', ms: Math.round(e.duration), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) });
    }
  }).observe({ entryTypes: ['gc'] });
} catch { /* gc entries unavailable */ }
export function getSpikes() {
  return spikes;
}

/**
 * Which browser origins may open a socket. CLIENT_ORIGIN is a comma-separated allow-list
 * (e.g. "https://code-killer.netlify.app"). localhost / 127.0.0.1 on any port is always allowed
 * outside production so local dev works without configuration.
 */
export function makeOriginCheck(env = process.env) {
  const allowed = (env.CLIENT_ORIGIN || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const dev = env.NODE_ENV !== 'production';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  return (origin) => !origin || allowed.includes(origin) || (dev && local.test(origin));
}

/** Rolling tick-time statistics for /stats (last ~60 s of ticks + all-time max). */
function makeTickStats() {
  const N = Math.round(60000 / TICK_MS);
  const ring = new Float64Array(N);
  let i = 0;
  let count = 0;
  let maxEver = 0;
  return {
    add(ms) {
      ring[i] = ms;
      i = (i + 1) % N;
      count = Math.min(N, count + 1);
      if (ms > maxEver) maxEver = ms;
    },
    summary() {
      let sum = 0;
      let max = 0;
      for (let k = 0; k < count; k++) {
        sum += ring[k];
        if (ring[k] > max) max = ring[k];
      }
      const r = (x) => Math.round(x * 100) / 100;
      return { windowSeconds: Math.round((count * TICK_MS) / 1000), avgMs: count ? r(sum / count) : 0, maxMs: r(max), maxEverMs: r(maxEver), budgetMs: TICK_MS };
    },
  };
}

export function createGameServer({ port = Number(process.env.PORT) || 3000, log = true, env = process.env } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const originOk = makeOriginCheck(env);
  const io = new Server(server, {
    cors: { origin: (origin, cb) => cb(null, originOk(origin)) },
    allowRequest: (req, cb) => cb(null, originOk(req.headers.origin)), // also enforce for the websocket transport
    maxHttpBufferSize: 1e4,
  });
  const rooms = new Map();
  const tickStats = makeTickStats();
  const startedAt = Date.now();

  // The client is hosted separately (Netlify); this server only speaks Socket.io + these endpoints.
  app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));

  // Operator stats, protected by STATS_KEY (?key=...). Disabled entirely when STATS_KEY is unset.
  const keyOk = (req) => !!env.STATS_KEY && req.query.key === env.STATS_KEY;
  app.get('/stats', (req, res) => {
    if (!keyOk(req)) return res.status(env.STATS_KEY ? 401 : 404).type('text/plain').send(env.STATS_KEY ? 'unauthorized' : 'not found');
    let players = 0;
    let bots = 0;
    let playing = 0;
    for (const room of rooms.values()) {
      for (const p of room.players.values()) {
        if (p.isBot) bots++;
        else players++;
      }
      if (room.phase === 'playing') playing++;
    }
    const mem = process.memoryUsage();
    const mb = (b) => Math.round((b / 1048576) * 10) / 10;
    res.set('Cache-Control', 'no-store').json({
      playersOnline: players,
      socketsConnected: io.engine.clientsCount,
      bots,
      rooms: rooms.size,
      roomsPlaying: playing,
      tick: tickStats.summary(),
      memoryMB: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal) },
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      node: process.version,
      recentSpikes: spikes.slice(-20),
    });
  });
  app.get('/spikes', (req, res) => {
    if (!keyOk(req)) return res.status(env.STATS_KEY ? 401 : 404).type('text/plain').send(env.STATS_KEY ? 'unauthorized' : 'not found');
    res.json({ count: spikes.length, spikes });
  });

  const transport = { send: (playerId, event, data) => io.to(playerId).emit(event, data) };

  io.on('connection', (socket) => {
    const allow = makeLimiter();
    const getRoom = () => (socket.data.room ? rooms.get(socket.data.room) : null);

    const leave = () => {
      const room = getRoom();
      socket.data.room = null;
      if (!room) return;
      const humans = room.removePlayer(socket.id);
      if (humans === 0) rooms.delete(room.code);
    };

    const handle = (event, perSecond, fn) => {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!allow(event, perSecond)) return reply({ ok: false, error: 'Slow down' });
        try {
          const out = fn(payload ?? {}, reply);
          if (out !== undefined) reply(out);
        } catch (err) {
          if (err instanceof RoomError) reply({ ok: false, error: err.message });
          else {
            console.error(`[${event}]`, err);
            reply({ ok: false, error: 'Server error' });
          }
        }
      });
    };

    handle('room:create', 2, ({ name }) => {
      leave();
      const code = generateRoomCode((c) => rooms.has(c));
      const room = new Room(code, transport);
      rooms.set(code, room);
      room.addPlayer({ id: socket.id, name });
      socket.data.room = code;
      return { ok: true, code, selfId: socket.id };
    });

    handle('room:join', 4, ({ code, name }) => {
      const c = normalizeRoomCode(code);
      if (!c) return { ok: false, error: 'Room codes are 6 letters/digits' };
      const room = rooms.get(c);
      if (!room) return { ok: false, error: 'Room not found' };
      if (socket.data.room !== c) leave();
      room.addPlayer({ id: socket.id, name });
      socket.data.room = c;
      return { ok: true, code: c, selfId: socket.id, phase: room.phase };
    });

    handle('room:leave', 4, () => {
      leave();
      return { ok: true };
    });

    handle('room:sync', 4, () => {
      const room = getRoom();
      return room ? { ok: true, state: room.lobbyState() } : { ok: false, error: 'Not in a room' };
    });

    handle('room:settings', 10, (patch) => {
      const room = getRoom();
      if (!room) return { ok: false, error: 'Not in a room' };
      return { ok: true, settings: room.updateSettings(socket.id, patch) };
    });

    handle('room:addBot', 6, () => {
      const room = getRoom();
      if (!room) return { ok: false, error: 'Not in a room' };
      room.addBot(socket.id);
      return { ok: true };
    });

    handle('room:removeBot', 6, () => {
      const room = getRoom();
      if (!room) return { ok: false, error: 'Not in a room' };
      room.removeBot(socket.id);
      return { ok: true };
    });

    handle('room:start', 2, () => {
      const room = getRoom();
      if (!room) return { ok: false, error: 'Not in a room' };
      room.start(socket.id);
      return { ok: true };
    });

    handle('chat', 4, ({ text }) => {
      getRoom()?.chat(socket.id, text);
    });

    handle('move', 45, (msg) => {
      getRoom()?.handleMove(socket.id, msg);
    });

    handle('killbox', 10, ({ open }) => {
      getRoom()?.setKillbox(socket.id, open);
    });

    handle('kill', 8, ({ code }) => {
      const room = getRoom();
      if (!room) return { ok: false, reason: 'not_allowed' };
      return room.attemptKill(socket.id, code);
    });

    // F: doors, switches, stairs, lockers/wardrobes, vents, security monitors
    handle('interact', 6, () => {
      const room = getRoom();
      if (!room) return { ok: false };
      return room.interact(socket.id);
    });
    handle('locker', 5, () => {
      getRoom()?.interact(socket.id);
    });

    // Clients report their own slow frames so both sides end up in one log
    handle('perf:spike', 2, (info) => {
      const room = getRoom();
      recordSpike({ side: 'client', room: room?.code, player: socket.id.slice(0, 6), ...sanitizeSpike(info) });
    });

    handle('vent:select', 6, ({ to }) => {
      getRoom()?.ventSelect(socket.id, Number(to));
    });

    handle('item:use', 6, ({ slot }) => {
      const room = getRoom();
      if (!room) return { ok: false };
      return room.useItem(socket.id, Number(slot));
    });

    handle('item:drop', 4, ({ slot }) => {
      const room = getRoom();
      if (!room) return { ok: false };
      return room.dropItem(socket.id, Number(slot));
    });

    handle('bounty:choose', 3, ({ choice }) => {
      const room = getRoom();
      if (!room) return { ok: false };
      return room.chooseReward(socket.id, choice === 'reveal' ? 'reveal' : 'shuffle');
    });

    // Debug helpers for automated browser testing. Only enabled with CK_DEBUG=1 (never in production).
    if (process.env.CK_DEBUG === '1') {
      handle('dev:tp', 20, ({ x, z, level = 0 }) => {
        const room = getRoom();
        const p = room?.players.get(socket.id);
        if (!room?.game || !p) return { ok: false };
        Object.assign(p, { x: Number(x), z: Number(z), level: Number(level) });
        room.forcePosition(p);
        return { ok: true };
      });
      handle('dev:give', 20, ({ item }) => {
        const room = getRoom();
        const p = room?.players.get(socket.id);
        if (!room?.game || !p) return { ok: false };
        room.giveItem(p, String(item), Date.now());
        return { ok: true };
      });
      handle('dev:event', 20, ({ type }) => {
        const room = getRoom();
        if (!room?.game) return { ok: false };
        const now = Date.now();
        if (type === 'lightsOut') room.triggerLightsOut(now);
        if (type === 'bounty') {
          room.game.bounty = null;
          room.pickBounty(now);
        }
        if (type === 'grace') room.game.graceUntil = now;
        return { ok: true };
      });
    }

    socket.on('disconnect', leave);
  });

  const interval = setInterval(() => {
    const now = Date.now();
    const t0All = performance.now();
    for (const room of rooms.values()) {
      const t0 = performance.now();
      room.tickEvents = [];
      try {
        room.tick(now);
      } catch (err) {
        console.error(`[tick ${room.code}]`, err);
      }
      const ms = performance.now() - t0;
      if (ms > 50) {
        const players = [...room.players.values()];
        recordSpike({
          side: 'server', kind: 'tick', room: room.code, ms: Math.round(ms), phase: room.phase,
          players: players.length, bots: players.filter((p) => p.isBot).length, alive: players.filter((p) => p.alive).length,
          events: [...new Set(room.tickEvents)].join(','), pathsLeft: room.pathBudget,
          heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
          recentGcMs: lastGc && now - lastGc.at < 200 ? Math.round(lastGc.ms) : 0,
        });
      }
    }
    tickStats.add(performance.now() - t0All);
  }, TICK_MS);

  return new Promise((resolve) => {
    server.listen(port, () => {
      const actualPort = server.address().port;
      if (log) console.log(`CODE KILLER server listening on http://localhost:${actualPort}`);
      resolve({
        port: actualPort,
        io,
        rooms,
        close: () => new Promise((r) => {
          clearInterval(interval);
          io.close();
          server.close(() => r());
        }),
      });
    });
  });
}

/**
 * Run a throw-away bot game for a few simulated seconds before taking players, so the first real
 * round doesn't run on cold (un-optimised) code: path-finding, vision and the map/nav-grid caches
 * are all hot. Takes well under a second; nothing is sent anywhere.
 */
export function warmUpServer(ticks = 400) {
  const t0 = performance.now();
  const room = new Room('WARMUP', { send() {} });
  room.addPlayer({ id: 'warm', name: 'Warm' });
  room.updateSettings('warm', { maxPlayers: 12, graceSeconds: 0 });
  for (let i = 0; i < 11; i++) room.addBot('warm');
  let now = 1e9;
  room.start('warm', now);
  for (let i = 0; i < ticks && room.game; i++) {
    now += TICK_MS;
    room.tick(now);
  }
  return Math.round(performance.now() - t0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ms = warmUpServer();
  console.log(`warm-up: simulated bot game in ${ms} ms`);
  createGameServer();
}
