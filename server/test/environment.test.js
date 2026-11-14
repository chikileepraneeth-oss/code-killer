import assert from 'node:assert/strict';
import test from 'node:test';
import { DOOR_CLOSE_DELAY, REFLECT } from '../../shared/constants.js';
import { reflectionSource } from '../src/systems/environment.js';
import { arenaRoom, placeAt, walk } from './helpers.js';

const code = (room, id) => room.players.get(id).code;

test('doors open automatically when someone walks up and close again after they pass', () => {
  const { room, t, now, g } = arenaRoom(2);
  placeAt(room, 'p0', 5, 0);
  placeAt(room, 'p1', -6, 0);
  room.players.get('p0').stillSince = now + 1e9;
  room.tick(now + 50);
  assert.equal(g.doorStr[0], '0');
  const { now: t1 } = walk(room, 'p1', [[-3, 0], [2, 0]], now + 100);
  assert.ok(room.players.get('p1').x > 1.8, 'walked straight through the doorway');
  assert.ok(t.of('p0', 'fx:door').some((d) => d.id === 0 && d.open), 'others hear the door open');
  placeAt(room, 'p1', 5, 2);
  room.updateDoors(t1 + 10);
  room.updateDoors(t1 + DOOR_CLOSE_DELAY + 50);
  assert.equal(g.doorStr[0], '0', 'closed again');
  assert.ok(t.of('p0', 'fx:door').some((d) => d.id === 0 && !d.open));
});

test('closed doors block codes; an open doorway lets you read them', () => {
  const { room, t, now, g } = arenaRoom(2);
  placeAt(room, 'p0', 2.5, 0);
  placeAt(room, 'p1', -2.5, 0);
  room.players.get('p0').stillSince = now + 1e9;
  room.tick(now + 50);
  assert.equal(t.last('p1', 'snap').codes.p0, undefined, 'closed door blocks sight');
  placeAt(room, 'p1', -1.2, 0);
  room.tick(now + 100);
  assert.equal(g.doorStr[0], '1');
  assert.ok(t.last('p1', 'snap').codes.p0, 'open door: visible');
});

test('sealed doors (red light) stay shut; a Master Key opens them for the rest of the round', () => {
  const { room, now, g } = arenaRoom(2);
  assert.equal(g.doorStr[1], '2', 'east door starts sealed');
  const p1 = placeAt(room, 'p1', 11.5, 0);
  walk(room, 'p1', [[8, 0]], now);
  assert.ok(p1.x > 10.3, 'cannot walk through a sealed door');
  p1.inv = ['masterkey', null];
  const res = room.useItem('p1', 0, now + 5000);
  assert.equal(res.ok, true);
  assert.equal(g.doorStr[1], '1');
  assert.deepEqual(p1.inv, [null, null]);
  placeAt(room, 'p1', -15, -15);
  for (let i = 1; i < 60; i++) room.tick(now + 5000 + i * 50);
  assert.equal(g.doorStr[1], '1', 'stays open even with nobody near');
  placeAt(room, 'p1', 11.5, 0);
  walk(room, 'p1', [[8, 0]], now + 9000);
  assert.ok(p1.x < 8.3, 'walked through the unsealed door');
});

test('locking doors from the inside no longer exists', () => {
  const { room } = arenaRoom(2);
  assert.equal(room.lockDoor, undefined);
});

test('stairs: walk up the ramp to the first floor and back down; codes never cross floors', () => {
  const { room, t, now } = arenaRoom(2);
  const p0 = placeAt(room, 'p0', 0.9, -2.5);
  let r = walk(room, 'p0', [[0.9, -4.05], [6.2, -4.05]], now);
  assert.equal(p0.level, 1, 'reached upstairs');
  assert.ok(Math.abs(p0.x - 6.2) < 0.2, 'stepped off the ramp onto the landing');
  placeAt(room, 'p1', 3, 2);
  room.tick(r.now + 50);
  assert.equal(t.last('p1', 'snap').codes.p0, undefined, 'different floors');
  r = walk(room, 'p0', [[6.2, -4.05], [0.9, -4.05], [0.9, -2.5]], r.now + 100);
  assert.equal(p0.level, 0, 'back on the ground floor');
  assert.ok(Math.abs(p0.z - -2.5) < 0.2);
});

test('stairs: walk down to the dark basement and back up; the basement is always dark', () => {
  const { room, t, now } = arenaRoom(2);
  const p0 = placeAt(room, 'p0', 3.9, 2.5);
  let r = walk(room, 'p0', [[3.9, 3.95], [9.1, 3.95]], now);
  assert.equal(p0.level, -1, 'in the basement');
  placeAt(room, 'p1', 3.9, 2.5);
  r = walk(room, 'p1', [[3.9, 3.95], [9.1, 3.95]], r.now);
  placeAt(room, 'p0', 3, 0, -1);
  placeAt(room, 'p1', 8, 0, -1);
  p0.stillSince = now + 1e9;
  room.tick(r.now + 50);
  assert.equal(t.last('p1', 'snap').codes.p0, undefined, '5 units in the dark');
  placeAt(room, 'p1', 6, 0, -1);
  room.tick(r.now + 100);
  assert.ok(t.last('p1', 'snap').codes.p0, '3 units is close enough');
  placeAt(room, 'p0', 9.1, 3.95, -1);
  r = walk(room, 'p0', [[9.1, 3.95], [3.9, 3.95], [3.9, 2.5]], r.now + 1000);
  assert.equal(p0.level, 0, 'climbed back up');
});

test("you can't step onto a ramp from the side or fall into the stairwell", () => {
  const { room, now } = arenaRoom(2);
  const p0 = placeAt(room, 'p0', 3.5, -2.5);
  walk(room, 'p0', [[3.5, -4.5]], now);
  assert.equal(p0.level, 0);
  assert.ok(p0.z > -3.45, `stopped by the rail (z=${p0.z})`);
  placeAt(room, 'p0', 3.5, -2.5, 1);
  walk(room, 'p0', [[3.5, -4.5]], now + 5000);
  assert.equal(p0.level, 1, 'did not fall through');
  assert.ok(p0.z > -3.45);
});

test('light switch: dark rooms only reveal codes very close', () => {
  const { room, t, now, g } = arenaRoom(2);
  g.doorStr = `1${g.doorStr.slice(1)}`;
  placeAt(room, 'p0', 5, 0);
  placeAt(room, 'p1', 1, 1.6);
  room.players.get('p0').stillSince = now + 1e9;
  room.tick(now + 50);
  assert.equal(t.last('p1', 'snap').codes.p0, code(room, 'p0'), 'lit: full code at 4.3');
  assert.equal(room.interact('p1', now + 60).type, 'switch');
  assert.equal(g.lightStr[0], '0');
  room.tick(now + 100);
  assert.equal(t.last('p1', 'snap').codes.p0, undefined, 'dark: 4.3 is too far');
  placeAt(room, 'p1', 2, 0);
  room.players.get('p0').stillSince = now - 1000;
  room.tick(now + 150);
  assert.equal(t.last('p1', 'snap').codes.p0, undefined, 'standing still in a dark room hides you');
  room.players.get('p0').stillSince = now + 140;
  room.tick(now + 151);
  assert.equal(t.last('p1', 'snap').codes.p0, code(room, 'p0'), 'moving inside it you can be read up close');
});

test('wardrobes and hide zones (bed) hide your code', () => {
  const { room, t, now } = arenaRoom(2);
  placeAt(room, 'p1', 6, -1);
  room.players.get('p1').stillSince = now + 1e9;
  const p0 = placeAt(room, 'p0', 7, 1.4);
  p0.stillSince = now;
  room.tick(now + 600);
  assert.equal(t.last('p1', 'snap').codes.p0, undefined, 'under the bed');
  placeAt(room, 'p0', 8.45, -2.0);
  assert.equal(room.interact('p0', now + 700).type, 'locker');
  room.tick(now + 750);
  assert.equal(t.last('p1', 'snap').codes.p0, undefined, 'in the wardrobe');
  room.interact('p0', now + 800);
  assert.equal(room.players.get('p0').inLocker, null);
});

test('vents: enter, crawl to the linked vent, exit; hidden and blind while inside', () => {
  const { room, t, now } = arenaRoom(2);
  placeAt(room, 'p0', -10, -9.5);
  placeAt(room, 'p1', -10, -7);
  room.players.get('p1').stillSince = now + 1e9;
  assert.equal(room.interact('p0', now).type, 'vent');
  const p0 = room.players.get('p0');
  room.tick(now + 50);
  assert.equal(t.last('p1', 'snap').codes.p0, undefined);
  assert.deepEqual(t.last('p0', 'snap').codes, {});
  assert.equal(t.last('p1', 'snap').ps.find((p) => p.id === 'p0').vt, 1);
  assert.equal(room.ventSelect('p0', 1), true);
  p0.ventInput = 1;
  let tt = now + 100;
  for (let i = 0; i < 300 && p0.vent.to !== null; i++) room.updateVents((tt += 50), 0.05);
  assert.equal(p0.vent.at, 1);
  room.interact('p0', tt);
  assert.equal(p0.vent, null);
  assert.ok(Math.abs(p0.z - 10) < 1);
});

test('security room: camera feeds reveal codes; leaving on F, damage or nearby kill attempts', () => {
  const { room, t, now, g } = arenaRoom(3);
  placeAt(room, 'p0', -15, -0.5);
  placeAt(room, 'p1', 15, -11);
  room.players.get('p1').stillSince = now + 1e9;
  room.tick(now + 50);
  assert.equal(t.last('p0', 'snap').codes.p1, undefined);
  assert.equal(room.interact('p0', now + 60).type, 'monitor');
  const p0 = room.players.get('p0');
  room.tick(now + 100);
  assert.equal(t.last('p0', 'snap').codes.p1, code(room, 'p1'));
  assert.equal(t.last('p0', 'snap').ps.find((p) => p.id === 'p0').wt, 1);
  room.interact('p0', now + 200);
  assert.equal(p0.watching, false);
  room.interact('p0', now + 300);
  placeAt(room, 'p2', -14, 3);
  room.setKillbox('p2', true);
  room.attemptKill('p2', code(room, 'p0') === '0000' ? '0001' : '0000', now + 400);
  assert.equal(p0.watching, false);
  room.interact('p0', now + 5000);
  g.zone.r = 1;
  g.zone.x = 15;
  room.tick(now + 5050);
  assert.equal(p0.watching, false);
});

test('reflections: only ONE digit + position, ~25% per 5s, only when looking at a mirror/puddle', () => {
  const { room, t, now, g } = arenaRoom(2);
  const p0 = placeAt(room, 'p0', -5, 14, 0, [0, 1]);
  assert.equal(reflectionSource(g.map, p0)?.kind, 'mirror');
  p0.lookZ = -1;
  assert.equal(reflectionSource(g.map, p0), null);
  p0.lookZ = 1;
  const own = p0.code;
  let hits = 0;
  let tt = now;
  for (let i = 0; i < 4000; i++) {
    tt += REFLECT.INTERVAL;
    const before = t.of('p0', 'glimpse').length;
    room.updateReflections(p0, tt);
    if (t.of('p0', 'glimpse').length > before) hits++;
  }
  assert.ok(Math.abs(hits / 4000 - REFLECT.CHANCE) < 0.03);
  for (const gm of t.of('p0', 'glimpse')) {
    assert.equal(gm.digit.length, 1);
    assert.equal(own[gm.pos - 1], gm.digit);
    assert.ok(!JSON.stringify(gm).includes(own));
  }
  const p1 = placeAt(room, 'p1', 13.5, 15, 0, [1, 0]);
  assert.equal(reflectionSource(g.map, p1)?.kind, 'puddle');
});

test('lights out: warned 3s ahead, then codes only within 3 units (flashlight beats it)', () => {
  const { room, t, now, g } = arenaRoom(2);
  placeAt(room, 'p0', -10, 0, 0, [1, 0]);
  placeAt(room, 'p1', -6, 0);
  room.players.get('p1').stillSince = now + 1e9;
  room.triggerLightsOut(now);
  assert.equal(g.lo.phase, 'warn');
  room.tick(now + 3100);
  assert.equal(g.lo.phase, 'on');
  room.tick(now + 3200);
  assert.equal(t.last('p0', 'snap').codes.p1, undefined);
  room.players.get('p0').inv = ['flashlight', null];
  room.useItem('p0', 0, now + 3300);
  room.tick(now + 3350);
  assert.equal(t.last('p0', 'snap').codes.p1, code(room, 'p1'));
  room.tick(now + 3000 + 16000);
  assert.equal(g.lo.phase, null);
});

test('lights out happens 1-3 times, scheduled after the grace period', () => {
  const { room, g } = arenaRoom(2, { settings: { lightsOut: true, graceSeconds: 20 } });
  assert.ok(g.loSchedule.length >= 1 && g.loSchedule.length <= 3);
  for (const t0 of g.loSchedule) assert.ok(t0 >= g.graceUntil);
  room.settings.lightsOut = false;
  room.scheduleLightsOut(0);
  assert.equal(g.loSchedule.length, 0);
});
