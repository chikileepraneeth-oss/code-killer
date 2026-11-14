import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_CODE_ALPHABET } from '../../shared/constants.js';
import { generateRoomCode, generateSecretCode, isValidCodeGuess, normalizeRoomCode } from '../src/codes.js';

test('room codes are 6 chars from the unambiguous alphabet', () => {
  for (let i = 0; i < 500; i++) {
    const c = generateRoomCode();
    assert.equal(c.length, 6);
    for (const ch of c) assert.ok(ROOM_CODE_ALPHABET.includes(ch), `bad char ${ch}`);
    assert.doesNotMatch(c, /[01OI]/);
  }
});

test('room codes avoid taken codes', () => {
  const taken = new Set();
  for (let i = 0; i < 300; i++) taken.add(generateRoomCode((c) => taken.has(c)));
  assert.equal(taken.size, 300);
});

test('normalizeRoomCode accepts lowercase/whitespace and rejects bad input', () => {
  assert.equal(normalizeRoomCode('  abcd23 '), 'ABCD23');
  assert.equal(normalizeRoomCode('ABC'), null);
  assert.equal(normalizeRoomCode('ABCD1O'), null); // contains 1 and O
  assert.equal(normalizeRoomCode(42), null);
});

test('secret codes are 4 digits and unique within the used set', () => {
  const used = new Set();
  for (let i = 0; i < 3000; i++) {
    const c = generateSecretCode(used);
    assert.match(c, /^\d{4}$/);
    assert.ok(!used.has(c));
    used.add(c);
  }
});

test('secret codes cover the full range including leading zeros', () => {
  const used = new Set();
  for (let i = 0; i < 9990; i++) used.add(generateSecretCode(used));
  assert.equal(used.size, 9990);
  const c = generateSecretCode(used);
  assert.ok(!used.has(c));
});

test('isValidCodeGuess', () => {
  assert.ok(isValidCodeGuess('0042'));
  assert.ok(!isValidCodeGuess('42'));
  assert.ok(!isValidCodeGuess('12a4'));
  assert.ok(!isValidCodeGuess(1234));
});
