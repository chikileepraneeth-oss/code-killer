// The one CODE KILLER map: a hand-designed village. Same layout every game.
// Three house types (small / family / big) are designed once in local coordinates
// (front door on the +z side) and placed with rotation, mirroring and colour variations.
import { MAP_SIZE } from './constants.js';
import { Builder, carveStairwells, emptyMap, H } from './mapkit.js';

const door = (a, b, extra = {}) => ({ a, b, type: 'door', ...extra });
const win = (a, b, extra = {}) => ({ a, b, type: 'window', ...extra });
const gap = (a, b) => ({ a, b, type: 'gap' });

const WALL_COLORS = ['#d9cdb4', '#b9c4b0', '#a9b8c8', '#c9a89a', '#d8d0c8', '#9fb0a0', '#c8b49a', '#b7a9c6'];
const ROOF_COLORS = ['#6a3a32', '#3e4a5a', '#4a4038', '#7a3028', '#3a4a3a'];

function addHouse(M, b, type, x0, z0, x1, z1, o) {
  const id = M.houses.length;
  b.houseId = id;
  M.houses.push({
    id, type, kind: o.kind || 'house', ...b.rect(x0, z0, x1, z1),
    hasUpper: !!o.upper, hasBasement: !!o.basement, roofY: o.roofY,
    wallColor: o.wallColor, roofColor: o.roofColor, pitched: o.pitched !== false,
  });
  return id;
}

// =============================================================================================
// Small house: 9 x 7, one floor, living room + bedroom + kitchen. Front and back doors.
// =============================================================================================
export function smallHouse(M, place) {
  const b = new Builder(M, place);
  addHouse(M, b, 'small', -4.5, -3.5, 4.5, 3.5, { roofY: H, wallColor: place.wallColor, roofColor: place.roofColor });
  b.floor(-4.5, -3.5, 4.5, 3.5, 0, 'house');
  b.shell(-4.5, -3.5, 4.5, 3.5, 0, {
    s: [door(-3.2, -1.8), win(-1.2, 0.0), win(1.6, 3.2)],
    n: [win(-4.0, -2.6), door(-1.4, 0.0), win(1.6, 3.2)],
    w: [win(-1.0, 0.6)],
    e: [win(-2.6, -1.2), win(1.4, 2.8)],
  });
  b.wall(0.5, -3.5, 0.5, 3.5, { openings: [door(-2.8, -1.4), gap(1.4, 2.8)] });
  b.wall(0.5, 0.5, 4.5, 0.5, {});
  const living = b.room(-4.5, -3.5, 0.5, 3.5, 0, 'living');
  const bedroom = b.room(0.5, -3.5, 4.5, 0.5, 0, 'bedroom');
  const kitchen = b.room(0.5, 0.5, 4.5, 3.5, 0, 'kitchen');
  // Living room
  b.box(-4.35, 1.3, -3.55, 3.2, 0.8, 'sofa', { level: 0, sight: false });
  if (place.variant) b.box(-2.9, -1.2, -1.9, -0.4, 0.75, 'table', { sight: false });
  else b.box(-2.6, 0.3, -1.6, 1.1, 0.75, 'table', { sight: false });
  b.box(-2.5, -3.35, -1.5, -2.95, 2.0, 'shelf', { sight: true });
  b.curtain(-4.35, -1.1, -3.6, 0.7, 0, false, true);
  b.switchFor(living, -3.7, 3.3);
  b.item(-2.0, 2.4);
  // Bedroom
  b.bed(2.35, -1.05, 4.35, 0.35, 0);
  b.locker(3.8, -3.05, 0, 1, 0, 'wardrobe');
  b.mirror(0.67, -0.2, 1, 0, 0);
  b.switchFor(bedroom, 0.7, -1.0);
  // Kitchen
  b.box(1.0, 0.65, 3.4, 1.25, 0.95, 'counter', { sight: false });
  b.box(3.65, 0.65, 4.35, 1.35, 1.9, 'fridge', { sight: true });
  b.box(2.6, 2.0, 3.6, 2.8, 0.75, 'table', { sight: false });
  b.decor('chairs', 3.1, 2.4, { yaw: 0 });
  b.switchFor(kitchen, 0.7, 1.05);
  b.item(2.0, 2.9);
  // Outside
  b.decor('porch', -2.5, 3.65, { yaw: 0 });
  M.lamps.push({ ...b.pt(-1.3, 3.65), level: 0, y: 2.5, kind: 'porch' });
  b.decor('chimney', 3.0, -1.8, { y: H, color: '#7a3a2a' });
  M.emergencyLights.push({ ...b.pt(-2.5, 2.9), level: 0 });
}

// =============================================================================================
// Family house: 12 x 9, two floors. Ground: living / hall with stairs / kitchen.
// Upstairs: bedroom / bathroom with mirror / kids' room. Front and back doors.
// =============================================================================================
export function familyHouse(M, place) {
  const b = new Builder(M, place);
  addHouse(M, b, 'family', -6, -4.5, 6, 4.5, { upper: true, roofY: 2 * H, wallColor: place.wallColor, roofColor: place.roofColor });
  b.floor(-6, -4.5, 6, 4.5, 0, 'house');
  b.floor(-6, -4.5, 6, 4.5, 1, 'upper');
  // ---- ground floor
  b.shell(-6, -4.5, 6, 4.5, 0, {
    s: [win(-5.0, -3.6), door(-1.75, -0.35), win(2.6, 4.0)],
    n: [win(-5.0, -3.6), door(-1.75, -0.35), win(2.6, 4.0)],
    w: [win(-2.6, -1.2), win(1.2, 2.6)],
    e: [win(-2.6, -1.2), win(1.2, 2.6)],
  });
  b.wall(-2, -4.5, -2, 4.5, { openings: [door(-1.0, 0.4)] });
  b.wall(1, -4.5, 1, 4.5, { openings: [gap(-3.6, -2.2)] });
  const living = b.room(-6, -4.5, -2, 4.5, 0, 'living');
  const hall = b.room(-2, -4.5, 1, 4.5, 0, 'hall');
  const kitchen = b.room(1, -4.5, 6, 4.5, 0, 'kitchen');
  b.stairs(-0.5, -1.4, 0.8, 2.6, [0, -1], 0, 1, 'stairs'); // 1.3 m wide
  b.box(-5.85, -1.0, -5.05, 1.0, 0.8, 'sofa', { sight: false });
  b.box(-4.4, -0.5, -3.4, 0.5, 0.75, 'table', { sight: false });
  b.box(-3.2, 3.95, -2.2, 4.35, 2.0, 'shelf', { sight: true });
  b.curtain(-5.1, 3.6, -3.5, 4.35, 0, true, false);
  b.switchFor(living, -2.2, 0.8);
  b.switchFor(hall, -1.8, 3.7);
  b.item(-4.6, 2.6);
  b.box(1.8, -4.35, 4.8, -3.75, 0.95, 'counter', { sight: false });
  b.box(5.15, -4.35, 5.85, -3.6, 1.9, 'fridge', { sight: true });
  b.box(3.0, 0.6, 4.2, 1.6, 0.75, 'table', { sight: false });
  b.decor('chairs', 3.6, 1.1, { yaw: 0 });
  b.curtain(5.1, 1.1, 5.85, 2.7, 0, false, false);
  b.switchFor(kitchen, 1.2, -1.8);
  b.item(3.4, 3.2);
  // ---- upstairs
  b.shell(-6, -4.5, 6, 4.5, 1, {
    s: [win(-5.0, -3.6), win(2.6, 4.0)],
    n: [win(-5.0, -3.6), win(2.6, 4.0)],
    w: [win(-2.6, -1.2), win(1.2, 2.6)],
    e: [win(-2.6, -1.2), win(1.2, 2.6)],
  });
  b.wall(-2, -4.5, -2, 4.5, { level: 1, openings: [door(-3.4, -2.0)] });
  b.wall(1, -4.5, 1, 4.5, { level: 1, openings: [door(-3.6, -2.2), door(3.0, 4.2)] });
  b.wall(1, 0, 6, 0, { level: 1 });
  const bedroom = b.room(-6, -4.5, -2, 4.5, 1, 'bedroom');
  const hall1 = b.room(-2, -4.5, 1, 4.5, 1, 'hall');
  const bath = b.room(1, -4.5, 6, 0, 1, 'bath');
  const kids = b.room(1, 0, 6, 4.5, 1, 'bedroom');
  b.bed(-5.85, -0.7, -3.85, 0.7, 1);
  b.locker(-2.8, 4.05, 0, -1, 1, 'wardrobe');
  b.mirror(-2.8, -4.33, 0, 1, 1);
  b.curtain(-5.1, -4.35, -3.5, -3.6, 1, true, true);
  b.switchFor(bedroom, -2.2, -1.6);
  b.switchFor(hall1, -1.8, -3.9);
  b.item(-4.6, 2.6, 1);
  b.mirror(4.0, -0.17, 0, -1, 1);
  b.box(3.55, -0.75, 4.45, -0.15, 0.9, 'cabinet', { level: 1, sight: false });
  b.box(4.2, -4.35, 5.85, -3.55, 0.6, 'tub', { level: 1, sight: false });
  b.curtain(4.2, -3.55, 5.85, -2.85, 1, true, true);
  b.switchFor(bath, 1.2, -1.8);
  b.bed(3.85, 0.6, 5.85, 2.0, 1);
  b.locker(2.1, 0.45, 0, 1, 1, 'wardrobe');
  b.box(2.4, 3.85, 3.6, 4.35, 0.8, 'desk', { level: 1, sight: false });
  b.switchFor(kids, 1.2, 2.6);
  b.item(4.0, 3.2, 1);
  // ---- outside
  b.decor('porch', -1.05, 4.65, { yaw: 0 });
  M.lamps.push({ ...b.pt(0.1, 4.65), level: 0, y: 2.5, kind: 'porch' });
  b.decor('chimney', 4.5, -2.5, { y: 2 * H, color: '#6a4a3a' });
  M.emergencyLights.push({ ...b.pt(-1.05, 3.8), level: 0 });
}

// =============================================================================================
// Big house: 14 x 11, two floors + dark basement. Ground: living, dining, hall, utility (stairs down),
// kitchen. Upstairs: master bedroom, bedroom, bathroom, study. Basement: boiler room (vent) + storage
// behind a sealed door. Front, back and side doors.
// =============================================================================================
export function bigHouse(M, place) {
  const b = new Builder(M, place);
  addHouse(M, b, 'big', -7, -5.5, 7, 5.5, { upper: true, basement: true, roofY: 2 * H, wallColor: place.wallColor, roofColor: place.roofColor });
  b.floor(-7, -5.5, 7, 5.5, 0, 'house');
  b.floor(-7, -5.5, 7, 5.5, 1, 'upper');
  b.floor(-7, -5.5, 7, 5.5, -1, 'basement');
  // ---- ground floor
  b.shell(-7, -5.5, 7, 5.5, 0, {
    s: [win(-5.5, -4.1), door(-1.25, 0.15), win(3.0, 4.4)],
    n: [win(-5.5, -4.1), door(-1.25, 0.15), win(2.4, 3.8)],
    w: [win(-4.0, -2.6), win(2.6, 4.0)],
    e: [win(1.6, 3.0), door(3.6, 5.0)],
  });
  b.wall(-1.5, -5.5, -1.5, 5.5, { openings: [door(-3.6, -2.2), gap(2.8, 4.2)] });
  b.wall(1.5, -5.5, 1.5, 5.5, { openings: [door(-4.6, -3.2), gap(3.2, 4.6)] });
  b.wall(-7, 0, -1.5, 0, { openings: [gap(-5.0, -3.6)] });
  b.wall(1.5, 1, 7, 1, { openings: [door(3.6, 5.0)] });
  const living = b.room(-7, -5.5, -1.5, 0, 0, 'living');
  const dining = b.room(-7, 0, -1.5, 5.5, 0, 'living');
  const hall = b.room(-1.5, -5.5, 1.5, 5.5, 0, 'hall');
  const utility = b.room(1.5, -5.5, 7, 1, 0, 'kitchen');
  const kitchen = b.room(1.5, 1, 7, 5.5, 0, 'kitchen');
  b.stairs(0, -1.4, 1.3, 2.6, [0, -1], 0, 1, 'stairs'); // 1.3 m wide
  b.stairs(5.5, -4.2, 6.8, -0.2, [0, -1], 0, -1, 'stairs'); // 1.3 m wide
  b.box(-6.8, -5.35, -4.8, -4.55, 0.8, 'sofa', { sight: false });
  b.box(-5.0, -2.8, -3.8, -2.0, 0.75, 'table', { sight: false });
  b.box(-3.3, -0.55, -1.9, -0.15, 2.0, 'shelf', { sight: true });
  b.curtain(-6.85, -4.1, -6.1, -2.5, 0, false, true);
  b.switchFor(living, -1.7, -1.9);
  b.item(-4.4, -1.2);
  b.box(-5.2, 2.2, -3.4, 3.4, 0.75, 'table', { sight: false });
  b.decor('chairs', -4.3, 2.8, { yaw: 0 });
  b.box(-6.85, 0.6, -6.45, 2.0, 2.0, 'shelf', { sight: true });
  b.switchFor(dining, -1.7, 2.4);
  b.switchFor(hall, -1.3, 4.6);
  b.box(1.8, -5.35, 3.6, -4.75, 0.95, 'counter', { sight: false });
  b.locker(1.95, -1.7, 1, 0, 0, 'locker');
  b.switchFor(utility, 1.7, -2.8);
  b.box(2.0, 4.75, 5.6, 5.35, 0.95, 'counter', { sight: false });
  b.box(1.65, 1.15, 2.35, 1.85, 1.9, 'fridge', { sight: true });
  b.box(3.2, 2.4, 4.4, 3.4, 0.75, 'table', { sight: false });
  b.curtain(6.1, 1.5, 6.85, 3.1, 0, false, false);
  b.switchFor(kitchen, 1.7, 2.8);
  b.item(4.0, 4.1);
  // ---- upstairs
  b.shell(-7, -5.5, 7, 5.5, 1, {
    s: [win(-5.5, -4.1), win(3.0, 4.4)],
    n: [win(-5.5, -4.1), win(3.0, 4.4)],
    w: [win(-4.0, -2.6), win(2.6, 4.0)],
    e: [win(-4.0, -2.6), win(2.6, 4.0)],
  });
  b.wall(-1.5, -5.5, -1.5, 5.5, { level: 1, openings: [door(-3.6, -2.2), door(2.8, 4.2)] });
  b.wall(1.5, -5.5, 1.5, 5.5, { level: 1, openings: [door(-3.6, -2.2), door(3.0, 4.4)] });
  b.wall(-7, 0, -1.5, 0, { level: 1 });
  b.wall(1.5, -1.5, 7, -1.5, { level: 1 });
  const master = b.room(-7, -5.5, -1.5, 0, 1, 'bedroom');
  const bed2 = b.room(-7, 0, -1.5, 5.5, 1, 'bedroom');
  const hall1 = b.room(-1.5, -5.5, 1.5, 5.5, 1, 'hall');
  const bath = b.room(1.5, -5.5, 7, -1.5, 1, 'bath');
  const study = b.room(1.5, -1.5, 7, 5.5, 1, 'living');
  b.bed(-6.85, -2.0, -4.85, -0.6, 1);
  b.locker(-2.7, -5.05, 0, 1, 1, 'wardrobe');
  b.mirror(-3.6, -0.17, 0, -1, 1);
  b.curtain(-5.6, -5.35, -4.0, -4.6, 1, true, true);
  b.switchFor(master, -1.7, -1.9);
  b.item(-5.4, -3.6, 1);
  b.bed(-6.85, 0.6, -4.85, 2.0, 1);
  b.locker(-2.7, 5.05, 0, -1, 1, 'wardrobe');
  b.box(-5.4, 4.85, -4.2, 5.35, 0.8, 'desk', { level: 1, sight: false });
  b.switchFor(bed2, -1.7, 2.4);
  b.switchFor(hall1, -1.3, -4.9);
  b.mirror(4.5, -1.67, 0, -1, 1);
  b.box(5.2, -5.35, 6.85, -4.55, 0.6, 'tub', { level: 1, sight: false });
  b.curtain(5.2, -4.55, 6.85, -3.85, 1, true, true);
  b.box(4.05, -2.25, 4.95, -1.65, 0.9, 'cabinet', { level: 1, sight: false });
  b.switchFor(bath, 1.7, -1.9);
  b.box(6.25, -0.5, 6.85, 1.3, 0.8, 'desk', { level: 1, sight: false });
  b.box(2.2, -1.35, 3.6, -0.95, 2.0, 'shelf', { level: 1, sight: true });
  b.box(4.0, -1.35, 5.4, -0.95, 2.0, 'shelf', { level: 1, sight: true });
  b.box(3.0, 4.55, 5.0, 5.35, 0.8, 'sofa', { level: 1, sight: false });
  b.curtain(6.1, 2.5, 6.85, 4.1, 1, false, false);
  b.switchFor(study, 1.7, 2.6);
  b.item(4.0, 2.0, 1);
  // ---- basement (always dark): boiler room with a vent, storage behind a sealed door
  b.shell(-7, -5.5, 7, 5.5, -1, {});
  b.wall(0, -5.5, 0, 5.5, { level: -1, openings: [door(-1.0, 0.4, { special: true, note: 'basement storage' })] });
  b.room(-7, -5.5, 0, 5.5, -1, 'basement', { alwaysDark: true, lightOn: false });
  b.room(0, -5.5, 7, 5.5, -1, 'basement', { alwaysDark: true, lightOn: false });
  b.box(0.3, 3.5, 1.5, 5.2, 2.2, 'boiler', { level: -1, sight: true });
  b.box(3.5, 3.8, 4.6, 4.9, 1.0, 'crate', { level: -1, sight: false });
  b.vent(2.6, -3.4, -1);
  b.locker(-6.55, 2.0, 1, 0, -1, 'wardrobe');
  b.box(-5.5, -4.8, -4.4, -3.7, 1.0, 'crate', { level: -1, sight: false });
  b.box(-3.0, 3.8, -1.8, 5.0, 2.0, 'stack', { level: -1, sight: true });
  b.item(-3.5, 0.6, -1);
  // ---- outside
  b.decor('porch', -0.55, 5.65, { yaw: 0 });
  M.lamps.push({ ...b.pt(0.6, 5.65), level: 0, y: 2.5, kind: 'porch' });
  b.decor('chimney', -4.5, -3, { y: 2 * H, color: '#5a5050' });
  M.emergencyLights.push({ ...b.pt(-0.55, 4.8), level: 0 });
}

// =============================================================================================
// Small shop: 10 x 8, shop floor with aisles + a storeroom behind a sealed door.
// =============================================================================================
export function shop(M, place) {
  const b = new Builder(M, place);
  addHouse(M, b, 'shop', -5, -4, 5, 4, { kind: 'shop', roofY: H, wallColor: '#e2dccf', roofColor: '#3e4a5a', pitched: false });
  b.floor(-5, -4, 5, 4, 0, 'house');
  b.shell(-5, -4, 5, 4, 0, {
    s: [win(-4.4, -1.0, { sill: 0.5, store: true }), door(-0.7, 0.7), win(1.0, 4.4, { sill: 0.5, store: true })],
    n: [door(-3.5, -2.1)],
    w: [win(-0.5, 1.5)],
    e: [win(0.5, 2.5)],
  });
  b.wall(1.5, -1, 5, -1, { openings: [door(2.4, 3.8, { special: true, note: 'shop storeroom' })] });
  b.wall(1.5, -4, 1.5, -1, {});
  const floorA = b.room(-5, -4, 1.5, 4, 0, 'store');
  b.room(1.5, -1, 5, 4, 0, 'store');
  const storeroom = b.room(1.5, -4, 5, -1, 0, 'storage', { lightOn: false });
  b.box(-3.8, -0.5, -1.4, 0.0, 1.8, 'shelf', { sight: true });
  b.box(-3.8, 1.5, -1.4, 2.0, 1.8, 'shelf', { sight: true });
  b.box(2.2, 0.6, 4.2, 1.3, 1.0, 'counter', { sight: false });
  b.box(-4.3, 2.9, -3.9, 3.3, 1.8, 'mannequin', { sight: false });
  M.decoys.push({ ...b.pt(-4.1, 3.1), level: 0, yaw: b.yaw(0) });
  b.curtain(-4.85, -3.85, -3.85, -2.85, 0, true, true);
  b.mirror(-4.83, -2.0, 1, 0, 0);
  b.switchFor(floorA, -4.8, 3.3);
  b.locker(4.55, -3.0, -1, 0, 0, 'locker');
  b.box(2.0, -3.6, 3.0, -2.6, 1.0, 'crate', { sight: false });
  b.switchFor(storeroom, 4.8, -1.4);
  b.item(3.6, -2.0);
  b.item(-2.6, 3.2);
  b.decor('sign', 0, 4.2, { yaw: 0, level: 0, text: 'GENERAL STORE', w: 8, hue: 1 });
  M.emergencyLights.push({ ...b.pt(0, 3.4), level: 0 });
  M._cams.push({ ...b.pt(4.6, 3.6), y: 2.7, level: 0, look: b.pt(-2, -1), name: 'SHOP' });
}

// =============================================================================================
// Security building: 9 x 7, one room with the camera monitors. Front and back doors.
// =============================================================================================
export function securityBuilding(M, place) {
  const b = new Builder(M, place);
  addHouse(M, b, 'security', -4.5, -3.5, 4.5, 3.5, { kind: 'security', roofY: H, wallColor: '#9aa3ad', roofColor: '#2a2c34', pitched: false });
  b.floor(-4.5, -3.5, 4.5, 3.5, 0, 'house');
  b.shell(-4.5, -3.5, 4.5, 3.5, 0, {
    s: [door(-0.7, 0.7)],
    n: [door(1.5, 2.9)],
    w: [win(-1.0, 0.4)],
    e: [win(-1.0, 0.4)],
  });
  const room = b.room(-4.5, -3.5, 4.5, 3.5, 0, 'security');
  b.switchFor(room, 1.1, 3.3);
  b.box(-2.5, -3.3, 1.0, -2.5, 0.8, 'desk', { sight: false });
  b.decor('monitors', -0.75, -2.9, { level: 0, yaw: 0 });
  M.security = { roomId: room.id, level: 0, monitor: b.pt(-0.75, -1.9), chair: { ...b.pt(-0.75, -1.6), yaw: b.yaw(Math.PI) }, cameras: [] };
  b.locker(-3.95, 2.5, 1, 0, 0, 'locker');
  b.curtain(3.6, -1.1, 4.35, 0.5, 0, false, false);
  M.emergencyLights.push({ ...b.pt(0, 0), level: 0 });
}

// =============================================================================================
// Garden shed in the park: dark, sealed door, a wardrobe and an item inside.
// =============================================================================================
function shed(M, place) {
  const b = new Builder(M, place);
  addHouse(M, b, 'shed', -2.5, -2, 2.5, 2, { kind: 'shed', roofY: 2.8, wallColor: '#8a6a48', roofColor: '#4a3a32' });
  b.floor(-2.5, -2, 2.5, 2, 0, 'house');
  b.shell(-2.5, -2, 2.5, 2, 0, { w: [door(-0.7, 0.7, { special: true, note: 'garden shed' })] }, 2.8);
  b.room(-2.5, -2, 2.5, 2, 0, 'storage', { lightOn: false, lamp: false });
  b.locker(1.9, 0.6, -1, 0, 0, 'wardrobe');
  b.box(0.8, -1.85, 2.35, -1.25, 0.9, 'counter', { sight: false });
  b.item(-0.2, -0.6);
}

// =============================================================================================
// The map
// =============================================================================================
export const VILLAGE_INFO = {
  name: 'Foggy Village', ground: '#1d2318', street: '#24262b', wall: '#4a4440', wallTrim: '#8a6a4a', roof: '#3a2626',
  floor: '#5b4632', fogColor: '#3a4450', sky: '#1c2228', lamp: '#ffb070', accent: '#ffb070', flicker: 0.02,
};
export const THEME_INFO = { village: VILLAGE_INFO };

export function buildVillage() {
  const M = emptyMap();
  M._cams = [];
  const S = MAP_SIZE;
  const half = S / 2;
  Object.assign(M, { id: 'village', theme: 'village', themeName: VILLAGE_INFO.name, size: S, weather: 'fog', sizeClass: 'fixed' });
  const w = new Builder(M);
  w.box(-half, -half, half, -half + 0.6, 3, 'perimeter');
  w.box(-half, half - 0.6, half, half, 3, 'perimeter');
  w.box(-half, -half, -half + 0.6, half, 3, 'perimeter');
  w.box(half - 0.6, -half, half, half, 3, 'perimeter');
  M.roads = [
    { minX: -half + 0.6, maxX: half - 0.6, minZ: -3.2, maxZ: 3.2, axis: 'x' },
    { minX: -3.2, maxX: 3.2, minZ: -half + 0.6, maxZ: half - 0.6, axis: 'z' },
  ];

  // ---- houses along the streets (north side faces +z, south side faces -z)
  const C = (i) => ({ wallColor: WALL_COLORS[i % WALL_COLORS.length], roofColor: ROOF_COLORS[i % ROOF_COLORS.length] });
  bigHouse(M, { ox: -13, oz: -10, ...C(0) });
  smallHouse(M, { ox: -28, oz: -8, ...C(1) });
  familyHouse(M, { ox: 12, oz: -9, ...C(2) });
  smallHouse(M, { ox: 27, oz: -8, mirror: true, variant: true, ...C(3) });
  shop(M, { ox: -12, oz: 9, rot: 2 });
  familyHouse(M, { ox: -27, oz: 10, rot: 2, mirror: true, ...C(4) });
  smallHouse(M, { ox: 11, oz: 8, rot: 2, variant: true, ...C(5) });
  bigHouse(M, { ox: 26, oz: 10.5, rot: 2, mirror: true, ...C(6) });
  securityBuilding(M, { ox: -14, oz: 25, rot: 2 });
  shed(M, { ox: 30.5, oz: -31.5 });

  // ---- central square
  w.box(-1.5, -1.5, 1.5, 1.5, 0.9, 'fountain', { sight: false });
  w.decor('fountain', 0, 0, { big: true });
  for (const [x, z] of [[-4.6, -4.6], [4.6, -4.6], [-4.6, 4.6], [4.6, 4.6]]) {
    w.box(x - 0.12, z - 0.12, x + 0.12, z + 0.12, 4, 'post', { sight: false });
    M.lamps.push({ x, z, level: 0, y: 4, kind: 'street' });
  }
  w.box(-2.4, 4.1, -1.0, 4.5, 0.5, 'bench', { sight: false });
  w.box(1.0, -4.5, 2.4, -4.1, 0.5, 'bench', { sight: false });
  w.puddle(2.2, 2.4, 0.9);
  w.item(2.6, -2.6);
  M._cams.push({ x: -2.8, z: -2.8, y: 3.4, level: 0, look: { x: 6, z: 6 }, name: 'SQUARE' });

  // ---- street lamps
  for (const p of [-30, -18, 18, 30]) {
    for (const [x, z] of [[p, -3.8], [p, 3.8], [-3.8, p], [3.8, p]]) {
      w.box(x - 0.12, z - 0.12, x + 0.12, z + 0.12, 4, 'post', { sight: false });
      M.lamps.push({ x, z, level: 0, y: 4, kind: 'street' });
    }
  }
  w.puddle(-22, 1.2, 1.0);
  w.puddle(1.0, -24, 0.9);
  w.puddle(24, -1.5, 0.8);

  // ---- alley (north-west, behind the houses): corridor with lockers, a vent and a sealed shortcut
  w.wall(-35.4, -20, -6, -20, { h: 3, openings: [gap(-26, -24.6), gap(-10, -8.6)] });
  w.wall(-35.4, -25, -6, -25, { h: 3, openings: [gap(-30, -28.6), door(-16, -14.6, { special: true, note: 'alley shortcut' })] });
  w.locker(-21, -20.45, 0, -1, 0, 'locker');
  w.locker(-12, -24.55, 0, 1, 0, 'locker');
  w.box(-18.6, -23.8, -17.4, -22.6, 2.4, 'stack');
  w.box(-29.6, -23.2, -28.4, -22.0, 1.1, 'crate', { sight: false });
  w.box(-8.2, -24.6, -6.6, -23.4, 1.3, 'crate', { sight: false });
  w.vent(-32, -22.5, 0);
  w.puddle(-14, -22.4, 0.9);
  w.lamp(-24, -22.5, 0, 'lantern');
  w.item(-12.5, -22.4);
  M._cams.push({ x: -6.6, z: -21.4, y: 2.8, level: 0, look: { x: -30, z: -22.5 }, name: 'ALLEY' });
  // north yard behind the alley
  for (const [x, z, r] of [[-30, -31, 1.5], [-22, -30, 1.4], [-10, -31, 1.5], [-26, -33.4, 1.2]]) w.bush(x, z, r);
  w.item(-15.3, -30.5);

  // ---- park (north-east): bushes, trees, pond, benches, the shed
  for (const [x, z, r] of [[8, -20, 1.5], [14.5, -24, 1.6], [20, -19, 1.4], [28.5, -21, 1.5], [33, -26, 1.3],
    [9, -31, 1.5], [21.5, -31.5, 1.4], [16, -33.3, 1.2], [6, -26, 1.2]]) w.bush(x, z, r);
  for (const [x, z, r] of [[12, -28, 1.8], [25.5, -25, 1.9], [4.8, -30.8, 1.5]]) {
    w.box(x - 0.25, z - 0.25, x + 0.25, z + 0.25, 3.0, 'trunk');
    w.decor('tree', x, z, { r });
  }
  w.puddle(18.5, -27, 1.4);
  w.puddle(17.2, -26.2, 0.8);
  w.box(19.5, -23.6, 21.5, -23.0, 0.5, 'bench', { sight: false });
  w.box(9.6, -23.4, 10.2, -21.4, 0.5, 'bench', { sight: false });
  w.lamp(15, -21, 0, 'lantern');
  w.lamp(25, -30, 0, 'lantern');
  w.item(14.2, -29.3);
  M._cams.push({ x: 4.6, z: -17.2, y: 3.2, level: 0, look: { x: 18, z: -28 }, name: 'PARK' });

  // ---- garden (south-east)
  for (const [x, z, r] of [[8, 20, 1.4], [14, 23.5, 1.5], [20.5, 26.5, 1.5], [26, 21, 1.4], [31.5, 27, 1.5],
    [12, 30.5, 1.5], [24.5, 31.5, 1.4], [33, 20, 1.2]]) w.bush(x, z, r);
  for (const [x, z, r] of [[6, 27, 1.7], [29, 32.5, 1.6]]) {
    w.box(x - 0.25, z - 0.25, x + 0.25, z + 0.25, 3.0, 'trunk');
    w.decor('tree', x, z, { r });
  }
  w.box(16.4, 19.6, 17.6, 20.8, 1.1, 'crate', { sight: false });
  w.box(22.4, 23.6, 23.6, 24.8, 2.2, 'stack');
  w.vent(17, 29.5, 0);
  w.lamp(19, 22, 0, 'lantern');
  w.item(20.5, 22.8);

  // ---- south-west yard around the security building
  for (const [x, z, r] of [[-28, 20, 1.5], [-30.5, 28, 1.5], [-24, 31.5, 1.4], [-6, 20.5, 1.3], [-6.5, 31, 1.4], [-24, 22, 1.2]]) w.bush(x, z, r);
  w.box(-29.25, 32.5, -28.75, 33, 3.0, 'trunk');
  w.decor('tree', -29, 32.75, { r: 1.7 });
  w.lamp(-21, 26, 0, 'lantern');
  w.item(-27, 25.5);

  // ---- vents: a ring through both big-house basements, the alley and the garden
  const order = [...M.vents].sort((a, c) => Math.atan2(a.z, a.x) - Math.atan2(c.z, c.x));
  for (let i = 0; i < order.length; i++) M.ducts.push({ a: order[i].id, b: order[(i + 1) % order.length].id });

  // ---- security cameras (fixed)
  M.security.cameras = M._cams.slice(0, 4).map((c, i) => ({
    id: i, name: `CAM ${i + 1} · ${c.name}`, x: c.x, z: c.z, y: c.y, level: c.level,
    yaw: +Math.atan2(c.look.x - c.x, c.look.z - c.z).toFixed(4), pitch: -0.32,
  }));
  delete M._cams;

  // ---- fixed, evenly spread spawn points (closest to the centre first so small games start together)
  const spawns = [
    [-9, 0], [9, 0], [0, -9], [0, 9], [-20, 0], [20, 0], [0, -21], [0, 21],
    [-33, 0], [33, 0], [0, -33], [0, 33], [-27, -30], [23, -22.5], [-26.5, 24], [22, 22],
  ];
  M.spawns = spawns.map(([x, z]) => ({ x, z }));
  M.itemCount = 6;
  M.lightsOuts = 2;
  carveStairwells(M); // real openings in the floors above every staircase (all house copies)
  return M;
}
