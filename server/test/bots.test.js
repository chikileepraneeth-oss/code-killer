import assert from 'node:assert/strict';
import test from 'node:test';
import { perceive } from '../src/bots.js';
import { Room } from '../src/room.js';
import { arenaMap, makeTransport } from './helpers.js';

function botRoom() {
  const room = new Room('BOTSAA', makeTransport());
  room.addPlayer({ id: 'p0', name: 'Human' });
  room.addBot('p0');
  room.updateSettings('p0', { graceSeconds: 0, lightsOut: false });
  room.mapOverride = arenaMap();
  room.start('p0', 2_000_000);
  room.game.nextBountyAt = Infinity;
  const bot = [...room.players.values()].find((p) => p.isBot);
  const human = room.players.get('p0');
  return { room, bot, human, now: 2_000_000 };
}
const place = (p, x, z, look) => {
  Object.assign(p, { x, z, level: 0, hidden: false, inLocker: null, vent: null });
  if (look) [p.lookX, p.lookZ] = look;
};
const known = (bot, id) => (bot.ai.mem.get(id) || []).filter((d) => d !== null).length;

test('bots see like players: a code behind the bot is not learned, one in front is', () => {
  const { room, bot, human, now } = botRoom();
  place(bot, -20, -5, [1, 0]);
  place(human, -23, -5); // 3 m directly behind the bot
  perceive(room, bot, now);
  assert.equal(known(bot, 'p0'), 0, 'nothing learned from behind');
  bot.lookX = -1; // the bot turns around
  perceive(room, bot, now + 50);
  assert.equal(known(bot, 'p0'), 4, 'full code once it looks');
  assert.deepEqual(bot.ai.mem.get('p0'), human.code.split(''));
});

test('bots: walls, distance and darkness limit what they learn', () => {
  const { room, bot, human, now } = botRoom();
  // Wall between them: the bot is outside the arena house, the human inside (door closed)
  place(bot, -2, 3.5, [1, 0]);
  place(human, 3, 3.5);
  perceive(room, bot, now);
  assert.equal(known(bot, 'p0'), 0, 'house wall blocks');
  // Far away in front: only a partial read (never the full code)
  place(bot, -19, -12, [1, 0]);
  place(human, -2, -12);
  perceive(room, bot, now);
  assert.ok(known(bot, 'p0') < 4, 'far = partial at most');
  // Lights out: nothing beyond 3 m
  bot.ai.mem.clear();
  Object.assign(room.game.lo, { phase: 'on', until: Infinity });
  place(human, -14, -12);
  perceive(room, bot, now);
  assert.equal(known(bot, 'p0'), 0, 'dark: 5 m is too far');
});

test('bots turn their heads: they keep looking around over time', () => {
  const { room, bot, human, now } = botRoom();
  // Nobody nearby to stare at: the bot walks around / scans on its own
  place(human, 18, 18);
  place(bot, -15, -15, [1, 0]);
  let turned = 0;
  let prev = Math.atan2(bot.lookX, bot.lookZ);
  for (let i = 0; i < 300; i++) {
    room.tick(now + 50 * (i + 1));
    const a = Math.atan2(bot.lookX, bot.lookZ);
    turned += Math.abs(Math.atan2(Math.sin(a - prev), Math.cos(a - prev)));
    prev = a;
  }
  assert.ok(turned > 1.5, `bot turned ${turned.toFixed(2)} rad in 15 s`);
});
