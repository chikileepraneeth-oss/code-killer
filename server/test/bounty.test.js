import assert from 'node:assert/strict';
import test from 'node:test';
import { BOUNTY } from '../../shared/constants.js';
import { arenaRoom } from './helpers.js';

const code = (room, id) => room.players.get(id).code;

test('bounty: chosen every 60s after grace, among the living', () => {
  const { room, t, now, g } = arenaRoom(4, { settings: { graceSeconds: 10 } });
  g.nextBountyAt = g.graceUntil + BOUNTY.INTERVAL;
  room.tick(now + 5000);
  assert.equal(g.bounty, null, 'not during grace');
  room.tick(g.graceUntil + BOUNTY.INTERVAL - 100);
  assert.equal(g.bounty, null);
  room.tick(g.graceUntil + BOUNTY.INTERVAL + 10);
  assert.ok(g.bounty);
  const b = room.players.get(g.bounty.id);
  assert.ok(b.alive);
  assert.ok(t.of('p0', 'announce').some((a) => a.type === 'bounty' && a.id === b.id));
  const snap = t.last('p0', 'snap');
  assert.equal(snap.bounty.id, b.id, 'bounty is broadcast (shown on everyone\'s minimap)');
  assert.ok(snap.ps.some((p) => p.id === b.id), 'bounty position is known');
});

test('bounty: never picks a dead player; needs 2+ alive', () => {
  const { room, now, g } = arenaRoom(3);
  room.setKillbox('p0', true);
  room.attemptKill('p0', code(room, 'p1'), now);
  for (let i = 0; i < 30; i++) {
    g.bounty = null;
    room.pickBounty(now + i);
    assert.notEqual(g.bounty?.id, 'p1');
  }
});

test('bounty: killing them shows a claim in the feed and offers the killer a reward choice', () => {
  const { room, t, now, g } = arenaRoom(3);
  g.bounty = { id: 'p1', until: now + BOUNTY.DURATION };
  room.setKillbox('p0', true);
  room.attemptKill('p0', code(room, 'p1'), now + 100);
  const feed = t.last('p2', 'feed');
  assert.equal(feed.cause, 'bounty');
  assert.equal(feed.killer, 'Player0');
  assert.equal(feed.victim, 'Player1');
  assert.equal(g.bounty, null);
  assert.ok(t.last('p0', 'bounty:reward'));
  assert.equal(room.players.get('p0').bountiesClaimed, 1);
});

test('bounty reward "reveal": the killer (only) learns their own full code, once', () => {
  const { room, t, now, g } = arenaRoom(3);
  g.bounty = { id: 'p1', until: now + BOUNTY.DURATION };
  room.setKillbox('p0', true);
  room.attemptKill('p0', code(room, 'p1'), now + 100);
  const res = room.chooseReward('p0', 'reveal', now + 200);
  assert.equal(res.ok, true);
  const msg = t.last('p0', 'you:selfCode');
  assert.equal(msg.code, code(room, 'p0'));
  assert.equal(msg.ms, BOUNTY.REVEAL_MS);
  assert.equal(t.of('p2', 'you:selfCode').length, 0);
  assert.equal(room.chooseReward('p0', 'reveal', now + 300).ok, false, 'only once');
});

test('bounty reward "shuffle" (also the default when the choice times out)', () => {
  const { room, t, now, g } = arenaRoom(4);
  g.bounty = { id: 'p1', until: now + BOUNTY.DURATION };
  room.setKillbox('p0', true);
  room.attemptKill('p0', code(room, 'p1'), now + 100);
  const before = code(room, 'p0');
  room.chooseReward('p0', 'shuffle', now + 200);
  assert.notEqual(code(room, 'p0'), before);
  assert.ok(t.last('p0', 'you:codeChanged'));
  // Timeout path
  g.bounty = { id: 'p2', until: now + 1000 + BOUNTY.DURATION };
  room.setKillbox('p3', true);
  room.attemptKill('p3', code(room, 'p2'), now + 1000);
  const b3 = code(room, 'p3');
  room.updateBounty(now + 1000 + BOUNTY.CHOICE_MS + 10);
  assert.notEqual(code(room, 'p3'), b3, 'auto shuffle');
});

test('bounty: surviving 30s grants a random item', () => {
  const { room, t, now, g } = arenaRoom(3);
  g.bounty = { id: 'p1', until: now + BOUNTY.DURATION };
  room.updateBounty(now + BOUNTY.DURATION + 1);
  assert.equal(g.bounty, null);
  assert.equal(room.players.get('p1').inv.filter(Boolean).length, 1);
  assert.ok(t.last('p1', 'item:got'));
  assert.ok(t.of('p0', 'announce').some((a) => a.type === 'bountySurvived'));
});

test('bounty: zone death is not a "claim"', () => {
  const { room, t, now, g } = arenaRoom(3);
  g.bounty = { id: 'p1', until: now + BOUNTY.DURATION };
  room.eliminate(room.players.get('p1'), 'zone', null, now);
  assert.equal(t.last('p0', 'feed').cause, 'zone');
  assert.equal(g.bounty, null);
});
