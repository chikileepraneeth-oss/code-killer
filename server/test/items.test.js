import assert from 'node:assert/strict';
import test from 'node:test';
import { ITEM_IDS, ITEMS, rollItem } from '../../shared/items.js';
import { arenaRoom, placeAt } from './helpers.js';

const code = (room, id) => room.players.get(id).code;
const give = (room, id, item, slot = 0) => {
  room.players.get(id).inv[slot] = item;
};

test('only three items exist: Master Key, Flashlight, Code Shuffle', () => {
  assert.deepEqual([...ITEM_IDS].sort(), ['flashlight', 'masterkey', 'shuffle']);
  const counts = {};
  for (let i = 0; i < 9000; i++) counts[rollItem()] = (counts[rollItem()] || 0) + 1;
  for (const id of ITEM_IDS) assert.ok(counts[id] > 0, id);
  assert.ok(ITEMS.shuffle.rarity === 'rare');
});

test('inventory: 2 slots, auto-pickup, full inventory leaves items, drop with Q', () => {
  const { room, t, now, g } = arenaRoom(2);
  const p = placeAt(room, 'p0', -18, -5);
  room.spawnPickupAt('item', 'flashlight', now, { x: -18, z: -5, level: 0 });
  room.spawnPickupAt('item', 'masterkey', now, { x: -18, z: -4.5, level: 0 });
  room.spawnPickupAt('item', 'shuffle', now, { x: -18, z: -5.5, level: 0 });
  room.tick(now + 50);
  room.tick(now + 100);
  room.tick(now + 150);
  assert.equal(p.inv.filter(Boolean).length, 2);
  assert.equal(g.pickups.filter((pk) => pk.type === 'item').length, 1, 'third item stays on the ground');
  assert.ok(t.last('p0', 'item:full'));
  const dropped = p.inv[0];
  assert.equal(room.dropItem('p0', 0, now + 200).ok, true);
  assert.equal(p.inv[0], null);
  room.tick(now + 250);
  assert.equal(p.inv[0] === dropped, false, 'no instant re-pickup');
});

test('Code Shuffle item: new unique code, and you are not told what it is', () => {
  const { room, t, now } = arenaRoom(3);
  const before = code(room, 'p0');
  give(room, 'p0', 'shuffle');
  const res = room.useItem('p0', 0, now);
  assert.equal(res.ok, true);
  const after = code(room, 'p0');
  assert.notEqual(after, before);
  assert.equal(new Set([...room.players.values()].map((q) => q.code)).size, 3);
  assert.ok(t.last('p0', 'you:codeChanged'));
  assert.ok(!JSON.stringify(t.of('p0')).includes(after));
  assert.ok(t.last('p1', 'fx:shimmer'));
  assert.deepEqual(room.players.get('p0').inv, [null, null], 'consumed');
});

test('Flashlight: toggles (not consumed), reads codes in the dark inside its cone, shows your beam', () => {
  const { room, t, now, g } = arenaRoom(2);
  placeAt(room, 'p0', -10, 0, 0, [1, 0]);
  placeAt(room, 'p1', -6, 0);
  room.players.get('p1').stillSince = now + 1e9;
  Object.assign(g.lo, { phase: 'on', until: Infinity });
  room.tick(now + 50);
  assert.equal(t.last('p0', 'snap').codes.p1, undefined);
  give(room, 'p0', 'flashlight');
  room.useItem('p0', 0, now + 60);
  room.tick(now + 100);
  assert.equal(t.last('p0', 'snap').codes.p1, code(room, 'p1'));
  assert.equal(t.last('p1', 'snap').ps.find((p) => p.id === 'p0').fl, 1);
  room.useItem('p0', 0, now + 120);
  assert.equal(room.players.get('p0').flashlightOn, false);
  assert.equal(room.players.get('p0').inv[0], 'flashlight');
  room.useItem('p0', 0, now + 130);
  room.dropItem('p0', 0, now + 140);
  assert.equal(room.players.get('p0').flashlightOn, false, 'dropping turns it off');
});

test('Master Key only works next to a sealed door', () => {
  const { room, now } = arenaRoom(2);
  placeAt(room, 'p0', -18, -5);
  give(room, 'p0', 'masterkey');
  const res = room.useItem('p0', 0, now);
  assert.equal(res.ok, false);
  assert.equal(room.players.get('p0').inv[0], 'masterkey', 'kept when nothing to open');
});

test('items drop on death', () => {
  const { room, now, g } = arenaRoom(3);
  give(room, 'p1', 'flashlight', 0);
  give(room, 'p1', 'shuffle', 1);
  room.setKillbox('p0', true);
  room.attemptKill('p0', code(room, 'p1'), now);
  assert.equal(g.pickups.filter((pk) => pk.type === 'item').length, 2);
});

test('removed powers are gone', () => {
  const { room } = arenaRoom(2);
  for (const removed of ['armor', 'teleport', 'codelock', 'jammer', 'lens', 'dart', 'smoke', 'scanner']) {
    assert.equal(ITEMS[removed], undefined, removed);
  }
  give(room, 'p0', 'armor');
  assert.equal(room.useItem('p0', 0).ok, false);
});
