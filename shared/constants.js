// Shared tuning constants used by BOTH server (authoritative) and client (prediction / rendering).

export const TICK_RATE = 20; // server ticks per second
export const TICK_MS = 1000 / TICK_RATE;

export const PLAYER_RADIUS = 0.4;
export const WALK_SPEED = 5.5; // units / second
export const CROUCH_MULT = 0.5;
export const KILLBOX_MULT = 0.2;
export const GHOST_SPEED = 12;
export const HEAD_HEIGHT = 1.9;
export const LEVEL_HEIGHT = 3.2; // vertical distance between floors (basement = -1, ground = 0, upstairs = 1)

// Progressive code reveal distances (2D distance, world units)
export const VIS = {
  FAR: 20, // beyond this: nothing
  MID: 13, // (MID, FAR] -> 1 digit
  CLOSE: 6, // (CLOSE, MID] -> 2 digits, <= CLOSE -> all 4
  DARK: 4, // dark room / basement: only this close, all-or-nothing
  LIGHTS_OUT: 3, // during the Lights Out event
};
export const FLASHLIGHT = { RANGE: 14, HALF_ANGLE: 0.6 }; // radians
// Bots see through the same first-person view cone as a player's camera (horizontal FOV).
export const VIEW_FOV = (90 * Math.PI) / 180;
export const EYE_HEIGHT = 1.62;

export const ROOM_CODE_LENGTH = 6;
// No 0/O, 1/I to avoid confusion
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const HOOD_DURATION = 30000;
export const HOOD_HIDDEN_DIGITS = 2;
export const SHIMMER_DURATION = 2500;
export const HIDE_STILL_MS = 400; // must stand still this long in a hiding spot
export const PICKUP_RADIUS = 1.3;
export const LOCKER_RANGE = 1.8;
export const INTERACT_RANGE = 1.6;
export const MAX_HEALTH = 100;

// Doors open automatically when someone walks up and close after they pass
export const DOOR_OPEN_RANGE = 1.7;
export const DOOR_CLOSE_RANGE = 2.3;
export const DOOR_CLOSE_DELAY = 700;

// Vents
export const VENT_SPEED = 1.8;
export const VENT_DEPTH = -0.75; // duct height below the floor of its level

// Lights out
export const LIGHTS_OUT_WARNING = 3000;
export const LIGHTS_OUT_MIN = 10000;
export const LIGHTS_OUT_MAX = 15000;

// Reflections (mirrors / puddles)
export const REFLECT = { INTERVAL: 5000, CHANCE: 0.25, RANGE: 2.2, SHOW_MS: 4000 };

// Bounty
export const BOUNTY = { INTERVAL: 60000, DURATION: 30000, REVEAL_MS: 5000, CHOICE_MS: 15000 };

// Items
export const INVENTORY_SLOTS = 2;

// Kill attempt rate limiting (token bucket) - independent of penalties
export const KILL_RATE = {
  CAPACITY: 3,
  REFILL_MS: 1500, // one token per this many ms
  MIN_GAP_MS: 400, // absolute minimum between attempts
};

export const PENALTY_TYPES = ['lockout', 'reveal', 'death'];
export const ZONE_SPEEDS = ['slow', 'normal', 'fast'];
export const DEFAULT_SETTINGS = {
  maxPlayers: 10,
  penaltyType: 'lockout',
  lockoutSeconds: 4,
  revealSeconds: 8,
  deathAfter: 3,
  graceSeconds: 15,
  zoneSpeed: 'normal',
  lightsOut: true,
};

export const SETTINGS_LIMITS = {
  maxPlayers: [2, 16],
  lockoutSeconds: [1, 15],
  revealSeconds: [3, 20],
  deathAfter: [1, 10],
  graceSeconds: [0, 60],
};

// One fixed, hand-designed map. Only the zone's starting size depends on the player count,
// so small games still meet in the middle.
export const MAP_SIZE = 72;
export function zoneStartRadius(playerCount) {
  if (playerCount <= 4) return 26;
  if (playerCount <= 8) return 40;
  return 52;
}
export function sizeLabelFor(playerCount) {
  if (playerCount <= 4) return 'Small zone';
  if (playerCount <= 8) return 'Medium zone';
  return 'Full map';
}

// Zone: radius per stage as a fraction of the starting radius, wait before shrinking, shrink duration (seconds)
export const ZONE_FRACTIONS = [1, 0.68, 0.45, 0.27, 0.13, 0];
export const ZONE_DAMAGE = [5, 8, 12, 18, 26, 40]; // hp / second outside zone, by stage
export const ZONE_PRESETS = {
  slow: { wait: [45, 40, 35, 30, 25], shrink: [30, 25, 20, 20, 15] },
  normal: { wait: [30, 25, 20, 18, 15], shrink: [20, 20, 15, 12, 10] },
  fast: { wait: [15, 14, 12, 10, 8], shrink: [12, 12, 10, 8, 6] },
};
export function zoneTimeScale(startRadius) {
  return Math.min(1.3, Math.max(0.7, startRadius / 40));
}

export const PLAYER_COLORS = [
  '#ff3860', '#3ec7ff', '#ffd23f', '#7cff6b', '#c56bff', '#ff8a3d', '#3dffd8', '#ff5ec4',
  '#9aa7ff', '#e8ff5e', '#ff6b6b', '#5effa1', '#ffb3f0', '#62a8ff', '#ffcf99', '#b4ff3d',
];

export const BOT_NAMES = [
  'Viper', 'Mole', 'Whisper', 'Static', 'Hex', 'Moth', 'Cipher', 'Rook',
  'Glitch', 'Shade', 'Null', 'Wraith', 'Ember', 'Jinx', 'Socket', 'Patch',
];
