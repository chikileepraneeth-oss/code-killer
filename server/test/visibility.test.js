import assert from 'node:assert/strict';
import test from 'node:test';
import { digitsForDistance, inViewCone, makeCtx, revealOrder, visibleCode } from '../src/visibility.js';
import { warehouseMap } from './fixtures/warehouse.js';

const map = warehouseMap();
const ctx = (extra = {}) => makeCtx(map, extra.now ?? 1000, { lightsOut: false, ...extra });
const mk = (id, x, z, extra = {}) => ({ id, x, z, level: 0, alive: true, code: '4821', hidden: false, hoodUntil: 0, hoodDigits: null, ...extra });
const known = (s) => (s ? [...s].filter((c) => c !== '?').length : 0);

test('distance tiers: far -> nothing, medium -> 1-2 digits, close -> all 4', () => {
  assert.equal(digitsForDistance(25), 0);
  assert.equal(digitsForDistance(18), 1);
  assert.equal(digitsForDistance(10), 2);
  assert.equal(digitsForDistance(5), 4);
  assert.equal(digitsForDistance(5, true), 0);
  assert.equal(digitsForDistance(3, true), 4);

  const v = mk('v', -6, -8);
  assert.equal(visibleCode(v, mk('t', 15, -8), ctx()), null); // 21 units
  assert.equal(known(visibleCode(v, mk('t', 12, -8), ctx())), 1);
  assert.equal(known(visibleCode(v, mk('t', 4, -8), ctx())), 2);
  assert.equal(visibleCode(v, mk('t', -2, -8), ctx()), '4821');
});

test('reveal order is consistent per viewer-target pair and nested as you approach', () => {
  assert.deepEqual(revealOrder('a', 'b'), revealOrder('a', 'b'));
  assert.deepEqual([...revealOrder('a', 'b')].sort(), [0, 1, 2, 3]);
  const v = mk('viewer', -6, -8);
  const far = visibleCode(v, mk('target', 12, -8), ctx());
  const mid = visibleCode(v, mk('target', 4, -8), ctx());
  for (let i = 0; i < 4; i++) if (far[i] !== '?') assert.equal(mid[i], far[i], 'digits revealed far must stay revealed closer');
  // Different viewers can decode different digits first
  const orders = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => revealOrder(id, 'target')[0]));
  assert.ok(orders.size > 1);
});

test('never see your own code', () => {
  const me = mk('me', 0, -8);
  assert.equal(visibleCode(me, me, ctx()), null);
});

test('walls block codes (line of sight)', () => {
  // Pillar between -1..1 on both axes
  assert.equal(visibleCode(mk('v', -2.5, 0), mk('t', 2.5, 0), ctx()), null);
  assert.equal(visibleCode(mk('v', -2.5, -8), mk('t', 2.5, -8), ctx()), '4821');
});

test('hidden targets show nothing; dead targets show nothing', () => {
  const v = mk('v', 0, -8);
  assert.equal(visibleCode(v, mk('t', 1, -8, { hidden: true }), ctx()), null);
  assert.equal(visibleCode(v, mk('t', 1, -8, { alive: false }), ctx()), null);
});

test('hood hides 2 digits even up close, and expires', () => {
  const v = mk('v', 0, -8);
  const t = mk('t', 1, -8, { hoodUntil: 5000, hoodDigits: [1, 3] });
  assert.equal(visibleCode(v, t, ctx()), '4?2?');
  assert.equal(visibleCode(v, t, ctx({ now: 6000 })), '4821');
});

test('lights out / dark rooms: only very close', () => {
  const v = mk('v', 0, -8);
  assert.equal(visibleCode(v, mk('t', 5, -8), ctx({ lightsOut: true })), null);
  assert.equal(visibleCode(v, mk('t', 3, -8), ctx({ lightsOut: true })), '4821');
  // Target inside the dark room, viewer 5 units away inside too
  assert.equal(visibleCode(mk('v', 15, -20), mk('t', 20, -20), ctx()), null);
  assert.equal(visibleCode(mk('v', 17, -20), mk('t', 20, -20), ctx()), '4821');
});

test('ghosts see all codes regardless of distance/walls/hood', () => {
  const ghost = mk('g', -25, 25, { alive: false });
  assert.equal(visibleCode(ghost, mk('t', 25, -25, { hoodUntil: 99999, hoodDigits: [0, 1] }), ctx()), '4821');
});

test('flashlight cone reads codes in the dark (only where you point it)', () => {
  const v = mk('v', -6, -8, { flashlightOn: true, lookX: 1, lookZ: 0 });
  const t = mk('t', 2, -8);
  assert.equal(visibleCode(mk('v', -6, -8), t, ctx({ lightsOut: true })), null);
  assert.equal(visibleCode(v, t, ctx({ lightsOut: true })), '4821'.slice(0, 4).length === 4 ? visibleCode(v, t, ctx()) : null);
  assert.equal(visibleCode({ ...v, lookX: -1 }, t, ctx({ lightsOut: true })), null, 'pointing the other way');
});

test('levels and vents block everything', () => {
  assert.equal(visibleCode(mk('v', -6, -8), mk('t', -4, -8, { level: 1 }), ctx()), null, 'different floor');
  assert.equal(visibleCode(mk('v', -6, -8), mk('t', -4, -8, { vent: { at: 0 } }), ctx()), null, 'target in vent');
  assert.equal(visibleCode(mk('v', -6, -8, { vent: { at: 0 } }), mk('t', -4, -8), ctx()), null, 'viewer in vent');
});

test('view cone (bots see like a first-person camera): only what is in front', () => {
  const v = mk('v', -6, -8, { lookX: 1, lookZ: 0 });
  assert.equal(inViewCone(v, mk('t', 0, -8)), true, 'straight ahead');
  assert.equal(inViewCone(v, mk('t', -1, -4)), true, 'about 40 degrees off');
  assert.equal(inViewCone(v, mk('t', -6, -2)), false, '90 degrees to the side');
  assert.equal(inViewCone(v, mk('t', -12, -8)), false, 'behind');
  assert.equal(inViewCone(v, mk('t', -6.5, -8)), true, 'right next to you you notice them');
  assert.equal(visibleCode(v, mk('t', -12, -8), ctx(), { cone: true }), null, 'cone hides codes behind a bot');
  assert.equal(visibleCode(v, mk('t', -2, -8), ctx(), { cone: true }), '4821');
  assert.equal(visibleCode({ ...v, hoodUntil: 0 }, mk('t', -2, -8, { hoodUntil: 5000, hoodDigits: [0, 1] }), ctx(), { cone: true }), '??21', 'hood still applies');
});
