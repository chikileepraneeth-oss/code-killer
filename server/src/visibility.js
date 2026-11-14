import { FLASHLIGHT, VIEW_FOV, VIS } from '../../shared/constants.js';
import { dist2D, hasLineOfSight } from '../../shared/geometry.js';
import { hashString, mulberry32 } from '../../shared/rng.js';
import { isDarkSpot, levelGeo } from '../../shared/world.js';

const orderCache = new Map();

/**
 * Order in which a target's digits reveal to a given viewer. Deterministic per (viewer, target) pair
 * so approaching someone feels like progressively "decoding" them.
 */
export function revealOrder(viewerId, targetId) {
  const key = `${viewerId}|${targetId}`;
  let order = orderCache.get(key);
  if (!order) {
    const rand = mulberry32(hashString(key));
    order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (orderCache.size > 50000) orderCache.clear();
    orderCache.set(key, order);
  }
  return order;
}

/** How many digits are readable at a given (already scaled) distance. */
export function digitsForDistance(d, dark = false) {
  if (dark) return d <= VIS.DARK ? 4 : 0;
  if (d <= VIS.CLOSE) return 4;
  if (d <= VIS.MID) return 2;
  if (d <= VIS.FAR) return 1;
  return 0;
}

/** Is the target inside the viewer's flashlight cone? */
export function inFlashlight(viewer, target) {
  const dx = target.x - viewer.x;
  const dz = target.z - viewer.z;
  const d = Math.hypot(dx, dz);
  if (d > FLASHLIGHT.RANGE) return false;
  if (d < 1) return true;
  const lx = viewer.lookX ?? 0;
  const lz = viewer.lookZ ?? 1;
  const cos = (dx * lx + dz * lz) / d;
  return cos >= Math.cos(FLASHLIGHT.HALF_ANGLE);
}

/** Is the target inside a viewer's first-person view cone (bots use this; players see through their camera)? */
export function inViewCone(viewer, target, fov = VIEW_FOV) {
  const dx = target.x - viewer.x;
  const dz = target.z - viewer.z;
  const d = Math.hypot(dx, dz);
  if (d < 1.2) return true; // right next to you: you notice them
  const lx = viewer.lookX ?? 0;
  const lz = viewer.lookZ ?? 1;
  return (dx * lx + dz * lz) / d >= Math.cos(fov / 2);
}

/**
 * Build a visibility context: { map, now, lightsOut, doors (state string), lights (state string) }
 */
export function makeCtx(map, now, o = {}) {
  const ctx = { map, now, lightsOut: !!o.lightsOut, doors: o.doors ?? '', lights: o.lights ?? '' };
  ctx.geo = (level) => levelGeo(map, level, ctx.doors);
  return ctx;
}

/**
 * What `viewer` may currently see of `target`'s code.
 * Returns a 4-char string with '?' for unknown digits (e.g. "4?2?"), or null when nothing is visible.
 * This is the ONLY place code digits leave the server for gameplay purposes (besides the explicit
 * bounty "reveal" reward and single mirror glimpses).
 * opts.cone: also require the target to be inside the viewer's view cone (bots).
 */
export function visibleCode(viewer, target, ctx, opts = {}) {
  if (!viewer || !target) return null;
  if (viewer.id === target.id) return null; // never your own code
  if (!target.alive || !target.code) return null;

  // Ghosts / spectators see everything (they can't communicate with the living).
  if (!viewer.alive) return target.code;

  if (target.hidden || target.vent) return null;
  if (viewer.vent) return null;
  if ((viewer.level ?? 0) !== (target.level ?? 0)) return null;
  if (opts.cone && !inViewCone(viewer, target)) return null;

  const d = dist2D(viewer.x, viewer.z, target.x, target.z);
  let dark = ctx.lightsOut || isDarkSpot(ctx.map, target.x, target.z, target.level ?? 0, ctx.lights);
  if (dark && viewer.flashlightOn && inFlashlight(viewer, target)) dark = false;
  const n = dark ? (d <= (ctx.lightsOut ? VIS.LIGHTS_OUT : VIS.DARK) ? 4 : 0) : digitsForDistance(d);
  if (n === 0) return null;
  if (ctx.map && !hasLineOfSight(ctx.geo(target.level ?? 0), viewer.x, viewer.z, target.x, target.z)) return null;

  const order = revealOrder(viewer.id, target.id);
  const shown = [false, false, false, false];
  for (let i = 0; i < n; i++) shown[order[i]] = true;
  if (target.hoodUntil > ctx.now && target.hoodDigits) {
    for (const idx of target.hoodDigits) shown[idx] = false;
  }
  let out = '';
  let any = false;
  for (let i = 0; i < 4; i++) {
    if (shown[i]) {
      out += target.code[i];
      any = true;
    } else out += '?';
  }
  return any ? out : null;
}

/** Merge two partial code strings, preferring known digits. */
export function mergeCodes(a, b) {
  if (!a) return b;
  if (!b) return a;
  let out = '';
  for (let i = 0; i < 4; i++) out += a[i] !== '?' ? a[i] : b[i];
  return out;
}
