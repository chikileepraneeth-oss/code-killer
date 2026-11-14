import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../shared/constants.js';

/** 6-char room code from an unambiguous alphabet, unique against `isTaken`. */
export function generateRoomCode(isTaken = () => false) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
  throw new Error('Could not allocate a room code');
}

export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** Secret 4-digit code (0000-9999) not in `used` (a Set of strings). Uses crypto RNG so it can't be predicted. */
export function generateSecretCode(used) {
  if (used.size >= 10000) throw new Error('No codes left');
  for (;;) {
    const code = String(randomInt(10000)).padStart(4, '0');
    if (!used.has(code)) return code;
  }
}

export function isValidCodeGuess(raw) {
  return typeof raw === 'string' && /^\d{4}$/.test(raw);
}
