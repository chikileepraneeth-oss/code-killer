import assert from 'node:assert/strict';
import test from 'node:test';
import { KILL_RATE, WALK_SPEED } from '../../shared/constants.js';
import { Room, RoomError } from '../src/room.js';
import { makeRoom, makeTransport, place } from './helpers.js';

const codeOf = (room, id) => room.players.get(id).code;

test('lobby: host, host-only settings, min players, room full, name dedupe', () => {
  const t = makeTransport();
  const room = new Room('ABCDEF', t);
  room.addPlayer({ id: 'a', name: 'Ann' });
  assert.equal(room.hostId, 'a');
  assert.throws(() => room.start('a'), RoomError); // need 2 players
  room.addPlayer({ id: 'b', name: 'ann' });
  assert.equal(room.players.get('b').name, 'ann2');
  assert.throws(() => room.updateSettings('b', { maxPlayers: 4 }), /host/);
  room.updateSettings('a', { maxPlayers: 99, penaltyType: 'nonsense', graceSeconds: 5 });
  assert.equal(room.settings.maxPlayers, 16);
  assert.equal(room.settings.penaltyType, 'lockout');
  room.updateSettings('a', { maxPlayers: 2 });
  assert.throws(() => room.addPlayer({ id: 'c', name: 'C' }), /full/);
  assert.throws(() => room.addBot('a'), /full/);
  // Host leaves -> host transfers
  room.removePlayer('a');
  assert.equal(room.hostId, 'b');
  const state = t.last('b', 'room:state');
  assert.equal(state.players.length, 1);
  assert.equal(state.code, 'ABCDEF');
});

test('names are sanitized', () => {
  const room = new Room('ABCDEF', makeTransport());
  const p = room.addPlayer({ id: 'x', name: '  <b>evil</b>\u0000 name that is way too long ' });
  assert.ok(!/[<>]/.test(p.name));
  assert.ok(p.name.length <= 16);
});

test('start: unique codes, nobody ever receives their own code', () => {
  const { room, t, ids, now } = makeRoom(8);
  const codes = ids.map((id) => codeOf(room, id));
  assert.equal(new Set(codes).size, 8);
  for (const c of codes) assert.match(c, /^\d{4}$/);
  // Everyone stands close together in the open: maximum exposure
  ids.forEach((id, i) => place(room, id, -5 + i * 0.8, -8));
  for (let k = 0; k < 5; k++) room.tick(now + k * 50);
  for (const id of ids) {
    const own = codeOf(room, id);
    const msgs = t.log.filter((m) => m.playerId === id);
    for (const m of msgs) {
      const json = JSON.stringify(m.data);
      if (m.event === 'snap') {
        assert.equal(m.data.codes[id], undefined);
        assert.ok(!Object.values(m.data.codes).includes(own));
      }
      assert.ok(!json.includes(`"${own}"`), `${id} received own code in ${m.event}`);
    }
    // ...but they do see others' codes up close
    const snap = t.last(id, 'snap');
    assert.ok(Object.keys(snap.codes).length >= 1);
  }
});

test('codes are not sent when the server says the viewer cannot see them', () => {
  const { room, t, now } = makeRoom(2);
  place(room, 'p0', -2.5, 0);
  place(room, 'p1', 2.5, 0); // pillar between them
  room.tick(now + 50);
  assert.deepEqual(t.last('p0', 'snap').codes, {});
  place(room, 'p1', 25, 25); // far away
  room.tick(now + 100);
  assert.deepEqual(t.last('p0', 'snap').codes, {});
});

test('kill: correct code eliminates target; feed shows names only', () => {
  const { room, t, now } = makeRoom(3);
  room.setKillbox('p0', true);
  const target = codeOf(room, 'p1');
  const res = room.attemptKill('p0', target, now + 10);
  assert.equal(res.ok, true);
  assert.equal(room.players.get('p1').alive, false);
  assert.equal(room.players.get('p0').kills, 1);
  const feed = t.last('p2', 'feed');
  assert.equal(feed.killer, 'Player0');
  assert.equal(feed.victim, 'Player1');
  assert.ok(!JSON.stringify(feed).includes(target));
  assert.ok(t.last('p1', 'you:died'));
  assert.equal(room.phase, 'playing'); // 2 still alive
});

test('kill: must have kill box open, not in grace, valid format', () => {
  const { room, now } = makeRoom(3, { settings: { graceSeconds: 10 } });
  const target = codeOf(room, 'p1');
  assert.equal(room.attemptKill('p0', target, now + 10).reason, 'grace');
  assert.equal(room.attemptKill('p0', target, now + 11000).reason, 'killbox_closed');
  room.setKillbox('p0', true);
  assert.equal(room.attemptKill('p0', '12a4', now + 11000).reason, 'invalid');
  assert.equal(room.players.get('p1').alive, true);
  assert.equal(room.attemptKill('p0', target, now + 12000).ok, true);
});

test('kill: wrong guess -> lockout penalty; attempts during lockout rejected', () => {
  const { room, now } = makeRoom(3, { settings: { penaltyType: 'lockout', lockoutSeconds: 4 } });
  room.setKillbox('p0', true);
  const used = new Set([...room.players.values()].map((p) => p.code));
  let wrong = '0000';
  while (used.has(wrong)) wrong = String(Number(wrong) + 1).padStart(4, '0');
  const r1 = room.attemptKill('p0', wrong, now + 10);
  assert.equal(r1.reason, 'wrong');
  assert.equal(r1.ms, 4000);
  const r2 = room.attemptKill('p0', codeOf(room, 'p1'), now + 2000);
  assert.equal(r2.reason, 'locked');
  assert.equal(room.players.get('p1').alive, true);
  assert.equal(room.attemptKill('p0', codeOf(room, 'p1'), now + 4100).ok, true);
});

test('kill: own code counts as a wrong guess and looks identical to one', () => {
  const { room, now } = makeRoom(3);
  room.setKillbox('p0', true);
  const res = room.attemptKill('p0', codeOf(room, 'p0'), now + 10);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'wrong');
  assert.equal(room.players.get('p0').alive, true);
  assert.equal(room.players.get('p0').wrongGuesses, 1);
  assert.deepEqual(Object.keys(res).sort(), ['ms', 'ok', 'penalty', 'reason', 'wrongGuesses']);
});

test('kill: dead players codes do not count', () => {
  const { room, now } = makeRoom(3);
  room.setKillbox('p0', true);
  const c1 = codeOf(room, 'p1');
  room.attemptKill('p0', c1, now + 10);
  room.setKillbox('p0', true);
  room.setKillbox('p2', true);
  assert.equal(room.attemptKill('p2', c1, now + 20).reason, 'wrong');
});

test('rate limiting: token bucket + minimum gap', () => {
  const { room, now } = makeRoom(3);
  room.setKillbox('p0', true);
  // Invalid-format guesses consume tokens but give no penalty, isolating the limiter
  assert.equal(room.attemptKill('p0', 'xxxx', now).reason, 'invalid');
  assert.equal(room.attemptKill('p0', 'xxxx', now + 100).reason, 'rate_limited'); // min gap
  let t = now;
  const results = [];
  for (let i = 0; i < 8; i++) {
    t += KILL_RATE.MIN_GAP_MS + 10;
    results.push(room.attemptKill('p0', 'xxxx', t).reason);
  }
  assert.ok(results.includes('rate_limited'), results.join(','));
  // After resting, tokens come back
  assert.equal(room.attemptKill('p0', 'xxxx', t + KILL_RATE.REFILL_MS * 3).reason, 'invalid');
});

test('penalty: reveal location', () => {
  const { room, t, now } = makeRoom(3, { settings: { penaltyType: 'reveal', revealSeconds: 8 } });
  room.setKillbox('p0', true);
  const res = room.attemptKill('p0', codeOf(room, 'p0'), now + 10);
  assert.equal(res.penalty, 'reveal');
  room.tick(now + 60);
  const snap = t.last('p1', 'snap');
  assert.equal(snap.ps.find((p) => p.id === 'p0').rv, 1);
  room.tick(now + 9000);
  assert.equal(t.last('p1', 'snap').ps.find((p) => p.id === 'p0').rv, 0);
});

test('penalty: die after N wrong guesses', () => {
  const { room, t, now } = makeRoom(3, { settings: { penaltyType: 'death', deathAfter: 2 } });
  room.setKillbox('p0', true);
  const own = codeOf(room, 'p0');
  assert.equal(room.attemptKill('p0', own, now + 10).guessesLeft, 1);
  const r = room.attemptKill('p0', own, now + 2000);
  assert.equal(r.died, true);
  assert.equal(room.players.get('p0').alive, false);
  assert.equal(t.last('p1', 'feed').cause, 'guesses');
});

test('win condition: last player alive wins, room returns to lobby with stats', () => {
  const { room, t, now } = makeRoom(2);
  room.setKillbox('p1', true);
  room.attemptKill('p1', codeOf(room, 'p0'), now + 10);
  const over = t.last('p0', 'game:over');
  assert.ok(over);
  assert.equal(over.winnerId, 'p1');
  assert.equal(over.stats[0].id, 'p1');
  assert.equal(over.stats[0].kills, 1);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.players.size, 2); // room kept
  room.start('p0', now + 100); // can play again
  assert.equal(room.phase, 'playing');
});

test('leaving mid-game eliminates you and can end the game', () => {
  const { room, t } = makeRoom(2);
  room.removePlayer('p0');
  assert.equal(t.last('p1', 'game:over').winnerId, 'p1');
});

test('movement: server clamps speed (no teleporting) and collides with walls', () => {
  const { room, now } = makeRoom(2);
  const p = place(room, 'p0', -4, -8);
  p.budget = 0;
  p.budgetAt = now;
  room.handleMove('p0', { x: 20, z: -8, yaw: 0 }, now + 50);
  const maxStep = WALK_SPEED * 0.05 * 1.2 + 1e-6;
  assert.ok(p.x - -4 <= maxStep, `moved ${p.x + 4}`);
  // Spamming teleport packets can't exceed the cap
  for (let i = 1; i <= 20; i++) room.handleMove('p0', { x: 20, z: -8 }, now + 50 + i);
  assert.ok(p.x < -4 + 1.5);
  // Normal walking is accepted exactly
  const q = place(room, 'p1', -4, -9);
  q.budget = 0;
  q.budgetAt = now;
  room.handleMove('p1', { x: -4 + WALK_SPEED * 0.05, z: -9 }, now + 50);
  assert.ok(Math.abs(q.x - (-4 + WALK_SPEED * 0.05)) < 1e-6);
  // Crouch flag limits speed to 50%
  q.budget = 0;
  q.budgetAt = now + 50;
  room.handleMove('p1', { x: q.x + WALK_SPEED * 0.05, z: -9, cr: 1 }, now + 100);
  assert.ok(q.x - (-4 + WALK_SPEED * 0.05) <= WALK_SPEED * 0.05 * 0.5 * 1.2 + 1e-6);
  // Walls: walking into the pillar stops at its face
  const w = place(room, 'p0', -2, 0);
  w.budget = 10;
  w.budgetAt = now + 200;
  room.handleMove('p0', { x: 0, z: 0 }, now + 200);
  assert.ok(w.x <= -1.4 + 1e-6);
});

test('kill box slows you to 20% (server-side)', () => {
  const { room, now } = makeRoom(2);
  const p = place(room, 'p0', -4, -8);
  room.setKillbox('p0', true);
  p.budget = 0;
  p.budgetAt = now;
  room.handleMove('p0', { x: 0, z: -8 }, now + 1000);
  assert.ok(p.x + 4 <= WALK_SPEED * 0.2 * 0.5 + 0.25 + 1e-6);
});

test('Code Shuffle gives a new unique code without telling you what it is', () => {
  const { room, t, now } = makeRoom(4);
  const before = codeOf(room, 'p0');
  const p = room.players.get('p0');
  p.inv = ['shuffle', null];
  room.useItem('p0', 0, now);
  const after = codeOf(room, 'p0');
  assert.notEqual(after, before);
  assert.equal(new Set([...room.players.values()].map((q) => q.code)).size, 4);
  assert.ok(t.last('p0', 'you:codeChanged'));
  assert.ok(!JSON.stringify(t.of('p0')).includes(after));
  assert.ok(t.last('p1', 'fx:shimmer'));
});

test('hood pickup hides 2 digits from close viewers', () => {
  const { room, t, now } = makeRoom(2);
  place(room, 'p0', 0, -8);
  place(room, 'p1', 1, -8);
  room.collectPickup(room.players.get('p1'), { type: 'hood', x: 0, z: 0 }, now);
  room.tick(now + 50);
  const seen = t.last('p0', 'snap').codes.p1;
  assert.equal([...seen].filter((c) => c === '?').length, 2);
});

test('hiding: standing still in a bush hides your code; moving breaks it', () => {
  const { room, t, now } = makeRoom(2);
  const bush = room.game.map.bushes[0];
  place(room, 'p0', bush.x + 2, bush.z);
  const hider = place(room, 'p1', bush.x, bush.z);
  hider.stillSince = now;
  room.tick(now + 600);
  assert.equal(t.last('p0', 'snap').codes.p1, undefined);
  assert.equal(t.last('p1', 'snap').me.hidden, 1);
  hider.budget = 1;
  hider.budgetAt = now + 600;
  room.handleMove('p1', { x: bush.x + 0.2, z: bush.z }, now + 650);
  room.tick(now + 700);
  assert.ok(t.last('p0', 'snap').codes.p1);
});

test('lockers: enter hides you completely, exit puts you outside', () => {
  const { room, t, now } = makeRoom(2);
  const l = room.game.map.lockers.find((k) => k.x === 0); // lone locker by the pillar
  place(room, 'p0', l.exitX + 1, l.exitZ);
  place(room, 'p1', l.exitX, l.exitZ);
  assert.equal(room.toggleLocker('p1', now), true);
  assert.equal(room.players.get('p1').inLocker, l.id);
  assert.equal(room.toggleLocker('p0', now), false); // occupied, no other locker in range
  room.tick(now + 50);
  assert.equal(t.last('p0', 'snap').codes.p1, undefined);
  room.toggleLocker('p1', now + 100);
  assert.equal(room.players.get('p1').inLocker, null);
});

test('ghosts: invisible to the living, see every code, chat only with ghosts', () => {
  const { room, t, now } = makeRoom(3);
  room.setKillbox('p0', true);
  room.attemptKill('p0', codeOf(room, 'p2'), now + 10);
  place(room, 'p0', -20, -20);
  place(room, 'p1', 20, 20);
  room.tick(now + 60);
  const ghostSnap = t.last('p2', 'snap');
  assert.equal(ghostSnap.codes.p0, codeOf(room, 'p0'));
  assert.equal(ghostSnap.codes.p1, codeOf(room, 'p1'));
  assert.ok(!t.last('p0', 'snap').ps.some((p) => p.id === 'p2'));
  t.clear();
  room.chat('p2', 'p0 is 1234!', now + 1000);
  assert.equal(t.of('p0', 'chat').length, 0);
  assert.equal(t.of('p2', 'chat').length, 1);
  room.chat('p1', 'hello', now + 1000);
  assert.equal(t.of('p2', 'chat').length, 2);
});

test('zone: players outside take damage and are consumed', () => {
  const { room, t, now } = makeRoom(3);
  const z = room.game.zone;
  z.r = 3;
  z.x = 0;
  z.z = -8;
  z.phase = 'final';
  z.stage = 5;
  place(room, 'p0', 0, -8);
  place(room, 'p1', 1, -8);
  place(room, 'p2', 20, 20);
  for (let i = 1; i <= 200 && room.players.get('p2').alive; i++) room.tick(now + i * 50);
  assert.equal(room.players.get('p2').alive, false);
  assert.ok(t.of('p0', 'feed').some((f) => f.cause === 'zone' && f.victim === 'Player2'));
});

test('late joiner spectates as a ghost', () => {
  const { room, t } = makeRoom(2);
  room.addPlayer({ id: 'late', name: 'Late' });
  const start = t.last('late', 'game:start');
  assert.equal(start.spectator, true);
  assert.equal(room.players.get('late').alive, false);
});

test('bots: a full simulated round with bots runs to completion without errors', () => {
  const t = makeTransport();
  const room = new Room('BOTSAA', t);
  room.addPlayer({ id: 'h', name: 'Human' });
  for (let i = 0; i < 5; i++) room.addBot('h');
  room.updateSettings('h', { graceSeconds: 3, zoneSpeed: 'fast', penaltyType: 'lockout' });
  let now = 5_000_000;
  room.start('h', now);
  // Park the human far away inside a locker so the bots fight it out
  room.toggleLocker('h', now); // probably not in range; fine
  let ticks = 0;
  while (room.phase === 'playing' && ticks < 20 * 60 * 6) {
    now += 50;
    room.tick(now);
    ticks++;
  }
  assert.equal(room.phase, 'lobby', 'round should end (zone guarantees it)');
  const over = t.last('h', 'game:over');
  assert.ok(over.winnerName);
  const kills = over.stats.reduce((s, p) => s + p.kills, 0);
  console.log(`  bot round: ${(ticks / 20).toFixed(0)}s, ${kills} kills, winner ${over.winnerName}`);
});
