import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LEVEL_HEIGHT, VENT_DEPTH } from '@shared/constants.js';
import { pointInBox } from '@shared/geometry.js';
import { rectsMinus, stairHoles } from '@shared/mapkit.js';
import { ITEMS, RARITY_COLOR } from '@shared/items.js';
import { THEME_INFO } from '@shared/mapgen.js';
import { signTexture, TEX } from './textures.js';

const H = LEVEL_HEIGHT;
const REGION = 30; // static geometry is merged per 30x30 region (keeps frustum culling useful)

let glowTex = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

const iconCache = new Map();
export function iconTexture(icon, ring = '#fff') {
  const key = icon + ring;
  if (iconCache.has(key)) return iconCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(8,6,14,0.75)';
  g.beginPath();
  g.arc(64, 64, 54, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = ring;
  g.stroke();
  g.font = '64px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(icon, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  iconCache.set(key, t);
  return t;
}

// ----------------------------------------------------------------------------------------------
// Geometry helpers: box faces with world-space UVs + per-vertex tint
// ----------------------------------------------------------------------------------------------
const FACE_N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
let boxTemplate = null;

/** The 6 faces of a box as separate non-indexed geometries: [{geo, n:[x,y,z], c:[cx,cy,cz]}] */
function boxFaces(w, h, d, x, y, z) {
  if (!boxTemplate) boxTemplate = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const src = boxTemplate.attributes.position.array;
  const out = [];
  for (let f = 0; f < 6; f++) {
    const pos = new Float32Array(18);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let v = 0; v < 6; v++) {
      const i = (f * 6 + v) * 3;
      pos[v * 3] = src[i] * w + x;
      pos[v * 3 + 1] = src[i + 1] * h + y;
      pos[v * 3 + 2] = src[i + 2] * d + z;
      cx += pos[v * 3] / 6;
      cy += pos[v * 3 + 1] / 6;
      cz += pos[v * 3 + 2] / 6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const nor = new Float32Array(18);
    for (let v = 0; v < 6; v++) nor.set(FACE_N[f], v * 3);
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.push({ geo, n: FACE_N[f], c: [cx, cy, cz] });
  }
  return out;
}

/** Add world-space UVs (projected on the dominant normal axis) and a vertex colour. */
function finish(geo, color, scale = 2, swap = false) {
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const n = pos.length / 3;
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(nor[i * 3]);
    const ay = Math.abs(nor[i * 3 + 1]);
    const az = Math.abs(nor[i * 3 + 2]);
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    let u;
    let v;
    if (ay >= ax && ay >= az) {
      u = swap ? z : x;
      v = swap ? x : z;
    } else if (ax >= az) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u / scale;
    uv[i * 2 + 1] = v / scale;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function prepGeo(g) {
  return g.index ? g.toNonIndexed() : g;
}

const FLOOR_BY_ROOM = {
  living: ['planks', '#b08458'], bedroom: ['planks', '#9a6e48'], kitchen: ['tiles', '#e4e2dc'], bath: ['tiles', '#cfe2e6'],
  basement: ['concrete', '#6e6862'], store: ['planks', '#c8b090'], storage: ['concrete', '#5e5852'], security: ['tiles', '#8a929a'],
  hall: ['planks', '#a88058'],
};
const WALL_BY_ROOM = {
  living: '#efe2cc', bedroom: '#d4dcec', kitchen: '#e6eedc', bath: '#d6ecec', basement: '#8a847c',
  store: '#efe6d4', storage: '#7a746c', security: '#b8c0c8', hall: '#eadfca',
};

export class World {
  /** opts: { lights, spots, reflect, reflectRes, shadowSize } */
  constructor(scene, map, opts = {}) {
    this.scene = scene;
    this.map = map;
    this.opts = { lights: 8, spots: 4, reflect: true, reflectRes: 256, shadowSize: 1024, ...opts };
    this.theme = THEME_INFO[map.theme] || THEME_INFO.village;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.pickupObjs = new Map();
    this.pkCache = new Map(); // shared pickup geometry/materials (nothing is created per pickup)
    this.darkness = 0;
    this.doorObjs = [];
    this.lightsOutPhase = null;
    this.doorState = '';
    this.lightState = '';
    this.build();
  }

  makeMaterials() {
    const std = (map, o = {}) => new THREE.MeshStandardMaterial({ map: map || null, vertexColors: true, roughness: 0.85, metalness: 0.02, ...o });
    this.M = {
      ext: { mat: std(TEX.siding()), scale: 2 },
      int: { mat: std(TEX.plaster()), scale: 3 },
      trim: { mat: std(null, { roughness: 0.6 }), scale: 1 },
      stone: { mat: std(TEX.brick()), scale: 1.6 },
      roof: { mat: std(TEX.shingles(), { roughness: 0.95 }), scale: 2 },
      planks: { mat: std(TEX.planks(), { roughness: 0.7 }), scale: 2.2 },
      tiles: { mat: std(TEX.tiles(), { roughness: 0.35 }), scale: 1.4 },
      marble: { mat: std(TEX.marble(), { roughness: 0.18, metalness: 0.05 }), scale: 3 },
      concrete: { mat: std(TEX.concrete()), scale: 3 },
      wood: { mat: std(TEX.woodgrain(), { roughness: 0.65 }), scale: 1.2 },
      fabric: { mat: std(TEX.fabric(), { roughness: 1 }), scale: 0.6 },
      metal: { mat: std(TEX.metal(), { roughness: 0.4, metalness: 0.6 }), scale: 1.5 },
      furn: { mat: std(null, { roughness: 0.7 }), scale: 1 },
      leaf: { mat: std(null, { roughness: 0.9, flatShading: true }), scale: 1 },
      glow: { mat: new THREE.MeshBasicMaterial({ vertexColors: true }), scale: 1, noShadow: true },
      glass: { mat: new THREE.MeshStandardMaterial({ color: 0xbfe4ff, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.5, depthWrite: false, side: THREE.DoubleSide }), scale: 1, noShadow: true, order: 3 },
    };
  }

  // --------------------------------------------------------------------------- static build
  build() {
    const { map, group, theme } = this;
    const half = map.size / 2;
    this.makeMaterials();

    const k = 1.1;
    this.hemi = new THREE.HemisphereLight(0x9aa6d8, 0x2a1e2c, 1.35 * k);
    this.moon = new THREE.DirectionalLight(0xc0c8ff, 1.3 * k);
    this.moon.castShadow = this.opts.shadowSize > 0;
    if (this.moon.castShadow) {
      this.moon.shadow.mapSize.set(this.opts.shadowSize, this.opts.shadowSize);
      const sc = this.moon.shadow.camera;
      sc.left = sc.bottom = -28;
      sc.right = sc.top = 28;
      sc.near = 1;
      sc.far = 120;
      this.moon.shadow.bias = -0.0008;
      this.moon.shadow.normalBias = 0.03;
    }
    group.add(this.hemi, this.moon, this.moon.target);
    this.baseHemi = this.hemi.intensity;
    this.baseMoon = this.moon.intensity;

    // Ground
    const gt = TEX.grass().clone();
    gt.needsUpdate = true;
    const gSize = map.size + 60;
    gt.repeat.set(1 / 8, 1 / 8); // shape UVs are world metres
    // The ground is a shape with holes where basement stairs go down (rotated flat: shape y = -world z)
    const gShape = new THREE.Shape();
    gShape.moveTo(-gSize / 2, -gSize / 2);
    gShape.lineTo(gSize / 2, -gSize / 2);
    gShape.lineTo(gSize / 2, gSize / 2);
    gShape.lineTo(-gSize / 2, gSize / 2);
    gShape.closePath();
    for (const hl of stairHoles(map).filter((x) => x.level === 0)) {
      const p = new THREE.Path();
      p.moveTo(hl.minX, -hl.minZ);
      p.lineTo(hl.minX, -hl.maxZ);
      p.lineTo(hl.maxX, -hl.maxZ);
      p.lineTo(hl.maxX, -hl.minZ);
      p.closePath();
      gShape.holes.push(p);
    }
    const ground = new THREE.Mesh(new THREE.ShapeGeometry(gShape), new THREE.MeshStandardMaterial({
      map: gt, color: 0xffffff, roughness: 0.95,
    }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);

    // Static geometry buckets (material x region)
    const buckets = new Map();
    const M = this.M;
    const add = (matKey, geo, x, z) => {
      const rx = Math.floor((x + half) / REGION);
      const rz = Math.floor((z + half) / REGION);
      const key = `${matKey}|${rx}|${rz}`;
      if (!buckets.has(key)) buckets.set(key, { matKey, geos: [] });
      buckets.get(key).geos.push(geo);
    };
    const solid = (matKey, color, w, h, d, x, y, z, skip = null) => {
      for (const f of boxFaces(w, h, d, x, y, z)) {
        if (skip && skip(f)) continue;
        add(matKey, finish(f.geo, color, M[matKey].scale), x, z);
      }
    };
    const routed = (w, h, d, x, y, z, route) => {
      for (const f of boxFaces(w, h, d, x, y, z)) {
        const r = route(f);
        if (!r) continue;
        add(r[0], finish(f.geo, r[1], M[r[0]].scale), x, z);
      }
    };

    const houseAt = (x, z) => {
      for (const h of map.houses) if (pointInBox(x, z, h, 0.25)) return h;
      return null;
    };
    const roomAt = (x, z, level) => {
      for (const r of map.rooms) if (r.level === level && pointInBox(x, z, r, 0.05)) return r;
      return null;
    };
    const wallColorOf = (h) => h.wallColor || theme.wall;
    const interiorColor = (x, z, level) => {
      const r = roomAt(x, z, level);
      return r ? WALL_BY_ROOM[r.kind] || '#e8e4dc' : '#e8e4dc';
    };
    const trimColor = '#f2eee6';
    const isExterior = (b, h) => {
      const alongZ = b.maxX - b.minX < b.maxZ - b.minZ;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      return alongZ ? Math.abs(cx - h.minX) < 0.3 || Math.abs(cx - h.maxX) < 0.3 : Math.abs(cz - h.minZ) < 0.3 || Math.abs(cz - h.maxZ) < 0.3;
    };
    const outward = (f, h) => {
      const [nx, , nz] = f.n;
      const [x, , z] = f.c;
      if (nx > 0) return x >= h.maxX - 0.02;
      if (nx < 0) return x <= h.minX + 0.02;
      if (nz > 0) return z >= h.maxZ - 0.02;
      if (nz < 0) return z <= h.minZ + 0.02;
      return false;
    };
    const FURN = {
      crate: ['wood', '#b08858'], stack: ['wood', '#9a7448'], table: ['wood', '#8a5a38'], desk: ['wood', '#4a4a52'],
      shelf: ['wood', '#6a4a30'], wardrobe: ['wood', '#7a5236'], counter: ['wood', '#8a8a90'],
      cabinet: ['wood', '#c8c8cc'], bench: ['wood', '#7a5a3a'], fence: ['wood', '#8a6a48'], trunk: ['wood', '#5a3e28'],
      cafetable: ['wood', '#e8e4dc'], trapdoor: ['wood', '#6a4a30'], stairbody: ['wood', '#7a5a3e'], railing: ['wood', '#6a4a30'],
      sofa: ['fabric', '#8a3a4a'], bed: ['wood', '#6a4a34'], locker: ['metal', '#4a7a8a'], mannequin: ['furn', '#e4e4ec'],
      fountain: ['marble', '#e8e8f0'], planter: ['concrete', '#8a8a90'], kiosk: ['ext', '#ff9ad6'], post: ['metal', '#2a2a30'],
      column: ['marble', '#f6f4fa'], pillar: ['stone', '#a09a90'],
      fridge: ['metal', '#e8ecef'], tub: ['marble', '#f4f6f8'], boiler: ['metal', '#8a5a3a'], stairrail: ['wood', '#5a3e28'],
    };

    for (const b of map.boxes) {
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const base = b.level * H;
      const y = base + (b.y0 || 0) + b.h / 2;
      if (b.kind === 'wall' || b.kind === 'lintel' || b.kind === 'sill') {
        const h = houseAt(cx, cz);
        if (h) {
          const ext = b.level >= 0 && isExterior(b, h); // basement walls are underground: always interior
          const alongZ = w < d;
          routed(w, b.h, d, cx, y, cz, (f) => {
            if (f.n[1] > 0) return b.kind === 'sill' ? ['trim', trimColor] : ['int', '#dedad2'];
            if (f.n[1] < 0) return b.kind === 'lintel' ? ['int', '#ecebe6'] : null;
            const endFace = alongZ ? f.n[2] !== 0 : f.n[0] !== 0;
            if (ext && (endFace || outward(f, h))) return ['ext', wallColorOf(h)];
            return ['int', interiorColor(f.c[0] + f.n[0] * 0.3, f.c[2] + f.n[2] * 0.3, b.level)];
          });
          if (ext && b.level === 0 && (b.kind === 'wall' || b.kind === 'sill')) {
            // Brick plinth on the outside only (never inside the rooms)
            solid('stone', '#8a8278', w + 0.06, 0.5, d + 0.06, cx, 0.25, cz, (f) => f.n[1] !== 0 ? f.n[1] < 0 : !outward(f, h));
          }
        } else {
          solid('stone', '#9a9288', w, b.h, d, cx, y, cz, (f) => f.n[1] < 0);
        }
        continue;
      }
      if (b.kind === 'perimeter') {
        solid('stone', '#7a7268', w, b.h, d, cx, y, cz, (f) => f.n[1] < 0);
        continue;
      }
      if (b.kind === 'stairrail') {
        // Banister: thin rail on posts (the collision box is the full height, the look is lighter)
        solid('wood', '#5a3e28', w, 0.07, d, cx, base + (b.y0 || 0) + b.h - 0.035, cz);
        const alongX = w > d;
        const len = alongX ? w : d;
        const n = Math.max(2, Math.round(len / 0.6));
        for (let i = 0; i <= n; i++) {
          const t = -len / 2 + (i * len) / n;
          solid('wood', '#6a4a30', 0.05, b.h - 0.07, 0.05, alongX ? cx + t : cx, base + (b.y0 || 0) + (b.h - 0.07) / 2, alongX ? cz : cz + t);
        }
        continue;
      }
      const [mk, col] = FURN[b.kind] || ['furn', b.color || '#8a8a8a'];
      solid(mk, b.color || col, w, b.h, d, cx, y, cz, (f) => f.n[1] < 0);
      if (b.kind === 'bed') {
        const alongX = w > d;
        solid('fabric', '#e4e6f0', alongX ? w * 0.92 : w * 0.9, 0.16, alongX ? d * 0.9 : d * 0.92, cx, base + 0.63, cz);
        solid('fabric', '#4a5a8a', alongX ? w * 0.6 : w * 0.94, 0.06, alongX ? d * 0.94 : d * 0.6, alongX ? cx + w * 0.18 : cx, base + 0.73, alongX ? cz : cz + d * 0.18);
        solid('fabric', '#ffffff', alongX ? 0.35 : w * 0.7, 0.14, alongX ? d * 0.7 : 0.35, alongX ? b.minX + 0.3 : cx, base + 0.78, alongX ? cz : b.minZ + 0.3);
      } else if (b.kind === 'sofa') {
        const alongX = w > d;
        solid('fabric', '#a84a5a', alongX ? w : 0.25, 0.5, alongX ? 0.25 : d, alongX ? cx : b.minX + 0.12, base + b.h + 0.25, alongX ? b.minZ + 0.12 : cz);
      } else if (b.kind === 'table' || b.kind === 'cafetable') {
        solid('wood', '#c8a070', w + 0.1, 0.06, d + 0.1, cx, base + b.h + 0.03, cz);
      } else if (b.kind === 'fridge') {
        solid('metal', '#b8c0c8', w * 1.02, 0.03, d * 1.02, cx, base + b.h * 0.62, cz);
      } else if (b.kind === 'tub') {
        solid('glow', '#9ad0e6', w * 0.8, 0.02, d * 0.8, cx, base + b.h + 0.01, cz);
      } else if (b.kind === 'boiler') {
        solid('glow', '#ff7a30', 0.12, 0.08, 0.12, cx, base + b.h * 0.4, cz);
      } else if (b.kind === 'wardrobe' || b.kind === 'locker') {
        solid(b.kind === 'locker' ? 'metal' : 'wood', b.kind === 'locker' ? '#67d2e6' : '#4a3220', w * 1.04, 0.06, d * 1.04, cx, base + b.h + 0.03, cz);
      } else if (b.kind === 'shelf') {
        const alongX = w > d;
        for (let i = 1; i <= 3; i++) {
          for (let j = 0; j < 4; j++) {
            const t = (j + 0.5) / 4 - 0.5;
            const pc = ['#ff5e7a', '#5ec4ff', '#ffd23f', '#7cff6b', '#c56bff'][(i * 3 + j) % 5];
            solid('furn', pc, alongX ? w / 5 : d * 0.6, 0.28, alongX ? d * 0.6 : d / 5, cx + (alongX ? t * w : 0), base + i * 0.55 + 0.15, cz + (alongX ? 0 : t * d));
          }
        }
      }
    }

    // Stairwell openings (from the map data): no floor surface, slab or ground covers them
    const holes = stairHoles(map);
    const holesAt = (lv) => holes.filter((hl) => hl.level === lv);
    // Room floors (tiles / planks), cut around the openings
    for (const r of map.rooms) {
      if (r.houseId < 0) continue;
      const [mk, col] = FLOOR_BY_ROOM[r.kind] || ['planks', '#a07850'];
      const y = r.level === -1 ? -H + 0.02 : r.level * H + 0.025;
      for (const p of rectsMinus([r], holesAt(r.level))) {
        solid(mk, col, p.maxX - p.minX, 0.03, p.maxZ - p.minZ, (p.minX + p.maxX) / 2, y, (p.minZ + p.maxZ) / 2, (f) => f.n[1] !== 1);
      }
    }
    // Floor slabs: map.floors are already pieces around each opening. Pieces on the house outline
    // overhang 0.15 m to cover the wall tops; edges facing a stairwell stay flush with the opening.
    const grow = (p, h) => {
      if (!h) return p;
      const on = (a, b) => Math.abs(a - b) < 0.05;
      return {
        minX: p.minX - (on(p.minX, h.minX) ? 0.15 : 0), maxX: p.maxX + (on(p.maxX, h.maxX) ? 0.15 : 0),
        minZ: p.minZ - (on(p.minZ, h.minZ) ? 0.15 : 0), maxZ: p.maxZ + (on(p.maxZ, h.maxZ) ? 0.15 : 0),
      };
    };
    for (const f of map.floors) {
      const h = map.houses[f.houseId];
      if (f.level === 1) {
        const p = grow(f, h);
        routed(p.maxX - p.minX, 0.22, p.maxZ - p.minZ, (p.minX + p.maxX) / 2, H - 0.11, (p.minZ + p.maxZ) / 2, (fc) => {
          if (fc.n[1] > 0) return null; // walked-on surface = the room floors above
          if (fc.n[1] < 0) return ['int', '#efede8']; // ground-floor ceiling (with the matching opening)
          // Side faces: siding on the house outline, plaster around the stairwell opening
          return h && outward(fc, { minX: h.minX - 0.15, maxX: h.maxX + 0.15, minZ: h.minZ - 0.15, maxZ: h.maxZ + 0.15 }) ? ['ext', wallColorOf(h)] : ['int', '#e4dfd6'];
        });
      } else if (f.level === -1) {
        // Basement ceiling, open above the basement stairs
        for (const p of rectsMinus([f], holesAt(0))) {
          solid('concrete', '#7a746c', p.maxX - p.minX, 0.2, p.maxZ - p.minZ, (p.minX + p.maxX) / 2, -0.1, (p.minZ + p.maxZ) / 2, (fc) => fc.n[1] > 0);
        }
      }
    }
    // A wooden lip around each opening (the floor edge you see when looking down the stairwell)
    for (const hl of holes) {
      const y = hl.level * H + 0.03;
      const w = hl.maxX - hl.minX;
      const d = hl.maxZ - hl.minZ;
      solid('wood', '#5a3e28', w + 0.1, 0.08, 0.06, (hl.minX + hl.maxX) / 2, y, hl.minZ - 0.025);
      solid('wood', '#5a3e28', w + 0.1, 0.08, 0.06, (hl.minX + hl.maxX) / 2, y, hl.maxZ + 0.025);
      solid('wood', '#5a3e28', 0.06, 0.08, d, hl.minX - 0.025, y, (hl.minZ + hl.maxZ) / 2);
      solid('wood', '#5a3e28', 0.06, 0.08, d, hl.maxX + 0.025, y, (hl.minZ + hl.maxZ) / 2);
    }
    // Roofs (flat slab = ceiling of the top floor; pitched shingles on village houses)
    for (const h of map.houses) {
      const w = h.maxX - h.minX;
      const d = h.maxZ - h.minZ;
      const cx = (h.minX + h.maxX) / 2;
      const cz = (h.minZ + h.maxZ) / 2;
      const pitched = h.kind === 'house' || h.kind === 'shed';
      routed(w + 0.5, 0.25, d + 0.5, cx, h.roofY + 0.125, cz, (f) => {
        if (f.n[1] < 0) return ['int', '#efede8'];
        if (f.n[1] > 0) return pitched ? null : ['roof', '#4a3a3a'];
        return ['trim', '#3a2a26'];
      });
      if (pitched) {
        const alongX = w >= d;
        const span = (alongX ? d : w) + 0.9;
        const len = (alongX ? w : d) + 0.9;
        const shape = new THREE.Shape();
        shape.moveTo(-span / 2, 0);
        shape.lineTo(span / 2, 0);
        shape.lineTo(0, 1.9);
        shape.closePath();
        const pg = prepGeo(new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }));
        pg.deleteAttribute('uv');
        pg.translate(0, 0, -len / 2);
        if (alongX) pg.rotateY(Math.PI / 2);
        pg.translate(cx, h.roofY + 0.25, cz);
        add('roof', finish(pg, ['#6a3a32', '#3e4a5a', '#4a4038', '#7a3028'][h.id % 4], 2, !alongX), cx, cz);
      }
    }

    // Window frames + glass
    for (const win of map.windows) {
      const alongX = win.maxX - win.minX > win.maxZ - win.minZ;
      const len = alongX ? win.maxX - win.minX : win.maxZ - win.minZ;
      const cx = (win.minX + win.maxX) / 2;
      const cz = (win.minZ + win.maxZ) / 2;
      const base = win.level * H;
      const hh = win.y1 - win.y0;
      const dep = 0.38;
      const col = win.store ? '#2c2e36' : trimColor;
      const bx = (l, t, dd) => (alongX ? [l, t, dd] : [dd, t, l]);
      const sx = (off) => (alongX ? cx + off : cx);
      const sz = (off) => (alongX ? cz : cz + off);
      const glass = new THREE.BoxGeometry(alongX ? len : 0.03, hh, alongX ? 0.03 : len).toNonIndexed();
      glass.deleteAttribute('uv');
      glass.translate(cx, base + win.y0 + hh / 2, cz);
      add('glass', finish(glass, '#ffffff', 1), cx, cz);
      solid('trim', col, ...bx(len + 0.16, 0.07, dep + 0.12), cx, base + win.y0 + 0.02, cz);
      solid('trim', col, ...bx(len, 0.08, dep), cx, base + win.y1 - 0.04, cz);
      solid('trim', col, ...bx(0.07, hh, dep), sx(-len / 2 + 0.035), base + win.y0 + hh / 2, sz(-len / 2 + 0.035));
      solid('trim', col, ...bx(0.07, hh, dep), sx(len / 2 - 0.035), base + win.y0 + hh / 2, sz(len / 2 - 0.035));
      if (!win.store) {
        solid('trim', col, ...bx(0.045, hh, 0.06), cx, base + win.y0 + hh / 2, cz);
        solid('trim', col, ...bx(len, 0.045, 0.06), cx, base + win.y0 + hh * 0.55, cz);
      } else {
        const n = Math.max(1, Math.round(len / 2));
        for (let i = 1; i < n; i++) solid('trim', col, ...bx(0.06, hh, 0.08), sx(-len / 2 + (i * len) / n), base + win.y0 + hh / 2, sz(-len / 2 + (i * len) / n));
      }
    }
    // Door frames
    for (const d of map.doors) {
      const alongX = d.axis === 'x';
      const len = alongX ? d.maxX - d.minX : d.maxZ - d.minZ;
      const cx = (d.minX + d.maxX) / 2;
      const cz = (d.minZ + d.maxZ) / 2;
      const base = d.level * H;
      const col = d.special ? '#3a3a42' : trimColor;
      const bx = (l, t, dd) => (alongX ? [l, t, dd] : [dd, t, l]);
      solid('trim', col, ...bx(len + 0.2, 0.12, 0.4), cx, base + 2.46, cz);
      for (const s of [-1, 1]) {
        solid('trim', col, ...bx(0.1, 2.4, 0.4), alongX ? cx + s * (len / 2 + 0.04) : cx, base + 1.2, alongX ? cz : cz + s * (len / 2 + 0.04));
      }
    }

    // Stairs
    for (const s of map.stairs) {
      const [dx, dz] = s.dir;
      const alongX = Math.abs(dx) > 0;
      const len = alongX ? s.maxX - s.minX : s.maxZ - s.minZ;
      const width = alongX ? s.maxZ - s.minZ : s.maxX - s.minX;
      const steps = 10;
      const up = s.to > s.from;
      const startX = dx > 0 ? s.minX : dx < 0 ? s.maxX : (s.minX + s.maxX) / 2;
      const startZ = dz > 0 ? s.minZ : dz < 0 ? s.maxZ : (s.minZ + s.maxZ) / 2;
      const esc = s.style === 'escalator';
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) / steps;
        const sw = alongX ? len / steps : width;
        const sd = alongX ? width : len / steps;
        const color = esc ? (i % 2 ? '#9aa0aa' : '#6a707a') : '#8a6440';
        if (up) {
          const hh = ((steps - i) / steps) * H;
          solid(esc ? 'metal' : 'wood', color, sw, hh, sd, startX + dx * len * (1 - t), hh / 2, startZ + dz * len * (1 - t), (f) => f.n[1] < 0);
        } else {
          solid('wood', color, sw, 0.12, sd, startX + dx * len * t, -((i + 1) / steps) * H + 0.06, startZ + dz * len * t);
        }
      }
      if (esc) {
        for (const side of [-1, 1]) {
          const ox = alongX ? 0 : side * (width / 2 + 0.05);
          const oz = alongX ? side * (width / 2 + 0.05) : 0;
          const g = new THREE.BoxGeometry(alongX ? len : 0.04, 1.4, alongX ? 0.04 : len).toNonIndexed();
          g.deleteAttribute('uv');
          g.translate((s.minX + s.maxX) / 2 + ox, H * 0.5 + 0.4, (s.minZ + s.maxZ) / 2 + oz);
          add('glass', finish(g, '#ffffff', 1), s.minX, s.minZ);
          solid('glow', theme.accent, alongX ? len : 0.06, 0.06, alongX ? 0.06 : len, (s.minX + s.maxX) / 2 + ox, H * 0.5 + 1.1, (s.minZ + s.maxZ) / 2 + oz);
        }
      }
    }
    // Wardrobe / locker doors
    for (const l of map.lockers) {
      const base = l.level * H;
      const along = Math.abs(l.fx) > 0;
      for (let i = 0; i < 3; i++) solid('furn', '#07080a', along ? 0.02 : 0.5, 0.04, along ? 0.5 : 0.02, l.x + l.fx * 0.31, base + 1.55 + i * 0.12, l.z + l.fz * 0.31);
      solid('metal', '#c8c8d0', along ? 0.02 : 0.04, 0.18, along ? 0.04 : 0.02, l.x + l.fx * 0.31 + (along ? 0 : 0.15), base + 1.05, l.z + l.fz * 0.31 + (along ? 0.15 : 0));
    }
    // Vents
    this.ductGroup = new THREE.Group();
    this.ductGroup.visible = false;
    group.add(this.ductGroup);
    const ductMat = new THREE.MeshStandardMaterial({ color: 0x6a7480, metalness: 0.6, roughness: 0.5, side: THREE.BackSide, emissive: 0x1a2430 });
    for (const v of map.vents) {
      solid('metal', '#2a2e34', 0.9, 0.04, 0.9, v.x, v.level * H + 0.03, v.z);
      for (let i = -2; i <= 2; i++) solid('metal', '#6a727a', 0.8, 0.05, 0.06, v.x, v.level * H + 0.05, v.z + i * 0.15);
    }
    for (const d of map.ducts) {
      const a = map.vents[d.a];
      const b = map.vents[d.b];
      const A = new THREE.Vector3(a.x, a.level * H + VENT_DEPTH, a.z);
      const B = new THREE.Vector3(b.x, b.level * H + VENT_DEPTH, b.z);
      const len = A.distanceTo(B);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, len + 0.9, 1, 1, Math.max(1, Math.round(len))), ductMat);
      m.position.copy(A).add(B).multiplyScalar(0.5);
      m.lookAt(B);
      this.ductGroup.add(m);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, len), new THREE.MeshBasicMaterial({ color: 0x3ec7ff }));
      strip.position.copy(m.position);
      strip.quaternion.copy(m.quaternion);
      strip.translateY(0.33);
      this.ductGroup.add(strip);
    }

    // Bushes + decor
    const bushColor = '#2f5a32';
    for (const b of map.bushes) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.random();
        const rr = b.r * (0.35 + Math.random() * 0.35);
        const s = b.r * (0.45 + Math.random() * 0.25);
        const g = prepGeo(new THREE.IcosahedronGeometry(s, 0));
        g.deleteAttribute('uv');
        g.rotateX(Math.random());
        g.translate(b.x + Math.cos(a) * rr, s * 0.8, b.z + Math.sin(a) * rr);
        add('leaf', finish(g, bushColor), b.x, b.z);
      }
    }
    this.signs = [];
    for (const d of map.decor) this.buildDecor(d, solid, add);

    // Roads (hand-placed streets of the fixed village) with a pale kerb on each side
    if (map.roads && map.roads.length) {
      const geos = [];
      for (const r of map.roads) {
        const w = r.maxX - r.minX;
        const d = r.maxZ - r.minZ;
        const g = new THREE.PlaneGeometry(w, d);
        g.rotateX(-Math.PI / 2);
        const uv = g.attributes.uv.array;
        for (let q = 0; q < uv.length; q += 2) {
          uv[q] *= w / 4;
          uv[q + 1] *= d / 4;
        }
        g.translate((r.minX + r.maxX) / 2, r.axis === 'x' ? 0.012 : 0.014, (r.minZ + r.maxZ) / 2);
        geos.push(g);
        const alongX = r.axis === 'x';
        for (const side of [-1, 1]) {
          if (alongX) solid('concrete', '#8a8680', w, 0.08, 0.25, (r.minX + r.maxX) / 2, 0.04, side < 0 ? r.minZ - 0.12 : r.maxZ + 0.12);
          else solid('concrete', '#8a8680', 0.25, 0.08, d, side < 0 ? r.minX - 0.12 : r.maxX + 0.12, 0.04, (r.minZ + r.maxZ) / 2);
        }
      }
      const roads = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ map: TEX.asphalt(), roughness: 0.9 }));
      roads.receiveShadow = true;
      group.add(roads);
    }

    // Merge buckets
    this.staticMeshes = [];
    for (const bk of buckets.values()) {
      const info = M[bk.matKey];
      const mesh = new THREE.Mesh(mergeGeometries(bk.geos), info.mat);
      if (!info.noShadow) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
      if (info.order) mesh.renderOrder = info.order;
      group.add(mesh);
      this.staticMeshes.push(mesh);
    }
    this.buildDynamic();
  }

  /** Decorative props described by the map generator. */
  buildDecor(d, solid, add) {
    const { theme, map } = this;
    const base = (d.level ?? 0) * H;
    const yaw = d.yaw || 0;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = fz;
    const rz = -fx;
    const alongX = Math.abs(rx) > 0.5;
    const at = (fwd, right) => [d.x + fx * fwd + rx * right, d.z + fz * fwd + rz * right];
    const box = (mk, col, wRight, h, dFwd, fwd, right, y) => {
      const [x, z] = at(fwd, right);
      solid(mk, col, alongX ? wRight : dFwd, h, alongX ? dFwd : wRight, x, y, z);
    };
    switch (d.type) {
      case 'tree':
        for (let i = 0; i < 3; i++) {
          const g = prepGeo(new THREE.IcosahedronGeometry(d.r * (0.85 - i * 0.2), 0));
          g.deleteAttribute('uv');
          g.translate(d.x, 2.6 + i * 0.9, d.z);
          add('leaf', finish(g, i % 2 ? '#2e5232' : '#244628'), d.x, d.z);
        }
        break;
      case 'curtain':
        box('fabric', '#8a2a36', d.w, 2.25, 0.06, 0, 0, base + 1.15);
        box('metal', '#3a3a40', d.w + 0.2, 0.05, 0.05, 0, 0, base + 2.3);
        break;
      case 'monitors':
        for (let i = -1; i <= 1; i++) {
          box('furn', '#15181e', 0.9, 0.6, 0.08, 0, i * 1.05, base + 1.25);
          box('glow', '#2a8acf', 0.8, 0.5, 0.02, 0.06, i * 1.05, base + 1.25);
        }
        break;
      case 'fountain': {
        const r = d.big ? 1.5 : 1.15;
        solid('glow', '#4aa8e0', r * 1.9, 0.05, r * 1.9, d.x, 0.92, d.z);
        if (d.big) {
          const g = prepGeo(new THREE.CylinderGeometry(0.25, 0.35, 2.2, 10));
          g.deleteAttribute('uv');
          g.translate(d.x, 2, d.z);
          add('marble', finish(g, '#f4f2fa'), d.x, d.z);
          solid('glow', '#7ad0ff', 1.2, 0.08, 1.2, d.x, 3.1, d.z);
        }
        break;
      }
      case 'statue': {
        const g = prepGeo(new THREE.OctahedronGeometry(0.7, 0));
        g.deleteAttribute('uv');
        g.translate(d.x, 3.9, d.z);
        add('glow', finish(g, theme.accent), d.x, d.z);
        break;
      }
      case 'porch':
        box('stone', '#9a948a', 2.2, 0.16, 1.0, 0.55, 0, 0.08);
        for (const s of [-1, 1]) box('trim', '#f2eee6', 0.12, 2.6, 0.12, 1.0, s * 1.0, 1.3);
        box('roof', '#4a3a36', 2.6, 0.12, 1.3, 0.55, 0, 2.7);
        break;
      case 'chimney':
        solid('stone', d.color || '#7a3a2a', 0.75, 2.6, 0.75, d.x, (d.y ?? H * 2) + 1.3, d.z);
        solid('stone', '#3a3330', 0.9, 0.12, 0.9, d.x, (d.y ?? H * 2) + 2.6, d.z);
        break;
      case 'sign': {
        const colors = ['#ff5ec4', '#3ec7ff', '#ffd23f', '#7cff6b', '#ff8a3d', '#c56bff'];
        const color = colors[(d.hue ?? 0) % colors.length];
        box('furn', '#121218', d.w, 0.7, 0.12, 0.08, 0, base + H - 0.55);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(d.w * 0.95, (d.w * 0.95) / 4), new THREE.MeshBasicMaterial({ map: signTexture(d.text || 'SHOP', color), transparent: true, depthWrite: false }));
        const [x, z] = at(0.16, 0);
        m.position.set(x, base + H - 0.55, z);
        m.rotation.y = yaw;
        this.group.add(m);
        this.signs.push(m);
        break;
      }
      case 'balcony': {
        box('concrete', '#e4e2ea', d.w, 0.18, 1.4, 0.7, 0, base - 0.09);
        box('glow', theme.accent, d.w, 0.04, 0.04, 1.4, 0, base - 0.16);
        const [x, z] = at(1.38, 0);
        const g = new THREE.BoxGeometry(alongX ? d.w : 0.03, 1.0, alongX ? 0.03 : d.w).toNonIndexed();
        g.deleteAttribute('uv');
        g.translate(x, base + 0.5, z);
        add('glass', finish(g, '#ffffff', 1), x, z);
        box('metal', '#c8c8d0', d.w, 0.05, 0.08, 1.38, 0, base + 1.02);
        break;
      }
      case 'palm': {
        const hh = d.h || 4;
        const g = prepGeo(new THREE.CylinderGeometry(0.1, 0.16, hh, 7));
        g.deleteAttribute('uv');
        g.translate(d.x, 0.4 + hh / 2, d.z);
        add('wood', finish(g, '#7a5a3a', 1), d.x, d.z);
        for (let i = 0; i < 7; i++) {
          const leaf = prepGeo(new THREE.ConeGeometry(0.35, 2.2, 4));
          leaf.deleteAttribute('uv');
          leaf.scale(1, 1, 0.25);
          leaf.translate(0, 1.1, 0);
          leaf.rotateZ(-1.2);
          leaf.rotateY((i / 7) * Math.PI * 2);
          leaf.translate(d.x, 0.4 + hh, d.z);
          add('leaf', finish(leaf, '#3f8a46'), d.x, d.z);
        }
        break;
      }
      case 'chairs':
        for (let i = 0; i < 4; i++) {
          const a = yaw + (i * Math.PI) / 2;
          const x = d.x + Math.sin(a) * 0.8;
          const z = d.z + Math.cos(a) * 0.8;
          solid('wood', '#c84a5a', 0.42, 0.06, 0.42, x, 0.45, z);
          solid('metal', '#3a3a40', 0.06, 0.45, 0.06, x, 0.22, z);
          const side = Math.abs(Math.sin(a)) > 0.5;
          solid('wood', '#c84a5a', side ? 0.06 : 0.42, 0.45, side ? 0.42 : 0.06, d.x + Math.sin(a) * 1.0, 0.7, d.z + Math.cos(a) * 1.0);
        }
        break;
      default:
        break;
    }
  }

  // --------------------------------------------------------------------------- dynamic pieces
  buildDynamic() {
    const { map, group, theme } = this;
    const prep = (g) => {
      const o = g.index ? g.toNonIndexed() : g;
      if (o.attributes.uv) o.deleteAttribute('uv');
      return o;
    };

    // Mannequins (decoys) with a permanent "? ? ? ?"
    const manMat = new THREE.MeshStandardMaterial({ color: 0xe4e4ec, roughness: 0.45 });
    const manGeo = mergeGeometries([
      new THREE.CapsuleGeometry(0.3, 0.55, 3, 8).translate(0, 1.05, 0),
      new THREE.IcosahedronGeometry(0.25, 1).translate(0, 1.65, 0),
      new THREE.CylinderGeometry(0.06, 0.06, 0.6, 6).translate(0, 0.3, 0),
      new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12).translate(0, 0.03, 0),
    ].map(prep));
    this.decoys = [];
    const decoyLabel = this.makeLabelMaterial('? ? ? ?');
    for (const dc of map.decoys) {
      const m = new THREE.Mesh(manGeo, manMat);
      m.position.set(dc.x, (dc.level ?? 0) * H, dc.z);
      m.rotation.y = dc.yaw || 0;
      m.castShadow = true;
      const label = new THREE.Sprite(decoyLabel);
      label.scale.set(1.5, 0.56, 1);
      label.position.y = 2.6;
      m.add(label);
      group.add(m);
      this.decoys.push(m);
    }

    // Doors (individually animated, red light when locked)
    const doorMat = new THREE.MeshStandardMaterial({ map: TEX.woodgrain(), color: 0x8a5a36, roughness: 0.6, metalness: 0.05 });
    const specialMat = new THREE.MeshStandardMaterial({ color: 0x3a3a44, roughness: 0.4, metalness: 0.7 });
    const knobMat = new THREE.MeshStandardMaterial({ color: 0xd0b060, metalness: 1, roughness: 0.3 });
    for (const d of map.doors) {
      const along = d.axis === 'x';
      const len = along ? d.maxX - d.minX : d.maxZ - d.minZ;
      const pivot = new THREE.Group();
      pivot.position.set(along ? d.minX : (d.minX + d.maxX) / 2, d.level * H, along ? (d.minZ + d.maxZ) / 2 : d.minZ);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(along ? len : 0.08, 2.35, along ? 0.08 : len), d.special ? specialMat : doorMat);
      panel.position.set(along ? len / 2 : 0, 1.175, along ? 0 : len / 2);
      panel.castShadow = true;
      pivot.add(panel);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), knobMat);
      knob.position.set(along ? len - 0.15 : 0.07, 1.05, along ? 0.07 : len - 0.15);
      pivot.add(knob);
      const lightGroup = new THREE.Group();
      lightGroup.position.set((d.minX + d.maxX) / 2, d.level * H + 2.65, (d.minZ + d.maxZ) / 2);
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: d.special ? 0xff2040 : 0x33ff88 }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff2040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      halo.scale.set(0.9, 0.9, 1);
      lightGroup.add(light, halo);
      group.add(pivot, lightGroup);
      this.doorObjs.push({ d, pivot, light, halo, angle: d.open ? 1 : 0, target: d.open ? 1 : 0 });
      pivot.rotation.y = d.open ? -Math.PI / 2 : 0;
    }

    // Switches, ceiling lamps, emergency lights (instanced)
    this.switchMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.15, 0.1), new THREE.MeshBasicMaterial(), Math.max(1, map.switches.length));
    // Snap each switch onto the face of the nearest wall
    const walls = map.boxes.filter((b) => b.kind === 'wall');
    map.switches.forEach((s, i) => {
      let px = s.x;
      let pz = s.z;
      let best = 1.0;
      for (const b of walls) {
        if (b.level !== s.level) continue;
        const cx = Math.max(b.minX, Math.min(s.x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(s.z, b.maxZ));
        const d = Math.hypot(s.x - cx, s.z - cz);
        if (d > 0.001 && d < best) {
          best = d;
          px = cx + ((s.x - cx) / d) * 0.05;
          pz = cz + ((s.z - cz) / d) * 0.05;
        }
      }
      this.switchMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(px, s.level * H + 1.35, pz));
      this.switchMesh.setColorAt(i, new THREE.Color(0xffe080));
    });
    this.switchMesh.count = map.switches.length;
    group.add(this.switchMesh);

    this.lampSources = [];
    const ceil = map.lamps.filter((l) => l.kind === 'ceiling');
    this.ceilMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.22, 0.12, 14), new THREE.MeshBasicMaterial(), Math.max(1, ceil.length));
    ceil.forEach((l, i) => {
      this.ceilMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(l.x, l.level * H + H - 0.08, l.z));
      this.ceilMesh.setColorAt(i, new THREE.Color(theme.lamp));
      this.lampSources.push({ ...l, idx: i, kind: 'ceiling', color: new THREE.Color('#ffd9a0'), base: 8, range: 8, y: l.level * H + H - 0.4 });
    });
    this.ceilMesh.count = ceil.length;
    group.add(this.ceilMesh);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x24242a, metalness: 0.5, roughness: 0.5 });
    const bulbGeo = new THREE.SphereGeometry(0.16, 10, 8);
    for (const src of map.lamps.filter((x) => x.kind !== 'ceiling')) {
      const l = { ...src };
      const lampGroup = new THREE.Group();
      if (l.kind === 'lantern' || l.kind === 'ceilingpost') {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, l.y, 6), postMat);
        post.position.set(l.x, l.y / 2, l.z);
        lampGroup.add(post);
      } else if (l.kind === 'street') {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.08), postMat);
        arm.position.set(l.x + 0.55, l.y - 0.1, l.z);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.3), postMat);
        head.position.set(l.x + 1.1, l.y - 0.2, l.z);
        lampGroup.add(arm, head);
        l.x += 1.1;
        l.y -= 0.35;
      } else if (l.kind === 'hanging') {
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.8, 4), postMat);
        cable.position.set(l.x, l.y + 0.4, l.z);
        const shade = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.35, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a2c34, side: THREE.DoubleSide, metalness: 0.6 }));
        shade.position.set(l.x, l.y, l.z);
        lampGroup.add(cable, shade);
        l.y -= 0.15;
      }
      const bulb = new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: theme.lamp }));
      bulb.position.set(l.x, l.y, l.z);
      if (l.kind === 'porch') bulb.scale.setScalar(0.6);
      lampGroup.add(bulb);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: theme.lamp, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.scale.setScalar(l.kind === 'porch' ? 1.2 : 2.4);
      halo.position.copy(bulb.position);
      lampGroup.add(halo);
      group.add(lampGroup);
      const strong = l.kind === 'street' || l.kind === 'hanging';
      this.lampSources.push({ ...l, kind: 'post', color: new THREE.Color(theme.lamp), base: strong ? 20 : l.kind === 'porch' ? 6 : 14, range: strong ? 16 : l.kind === 'porch' ? 6 : 13, y: l.y - 0.2, bulb, halo, post: lampGroup });
    }
    this.emergency = map.emergencyLights.map((e) => ({ ...e, kind: 'emergency', color: new THREE.Color(0xff2030), base: 9, range: 10, y: (e.level ?? 0) * H + 2.6 }));
    this.emMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.12, 0.3), new THREE.MeshBasicMaterial(), Math.max(1, this.emergency.length));
    this.emergency.forEach((e, i) => {
      this.emMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(e.x, e.y + 0.15, e.z));
      this.emMesh.setColorAt(i, new THREE.Color(0x401010));
    });
    this.emMesh.count = this.emergency.length;
    group.add(this.emMesh);

    // Pooled real lights
    this.pool = [];
    for (let i = 0; i < this.opts.lights; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.7);
      group.add(l);
      this.pool.push(l);
    }
    this.spots = [];
    for (let i = 0; i < this.opts.spots; i++) {
      const s = new THREE.SpotLight(0xfff3d0, 0, 18, 0.55, 0.45, 1.2);
      group.add(s, s.target);
      this.spots.push(s);
    }

    // Mirrors + puddles (live reflectors only up close, if quality allows)
    const mirrorMat = new THREE.MeshStandardMaterial({ color: 0x9aa6b8, metalness: 1, roughness: 0.06 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a });
    this.mirrorMeshes = map.mirrors.map((m) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(m.w, m.y1 - m.y0), mirrorMat);
      mesh.position.set(m.x + m.nx * 0.02, m.level * H + (m.y0 + m.y1) / 2, m.z + m.nz * 0.02);
      mesh.lookAt(mesh.position.x + m.nx, mesh.position.y, mesh.position.z + m.nz);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(m.w + 0.12, m.y1 - m.y0 + 0.12, 0.04), frameMat);
      frame.position.copy(mesh.position).add(new THREE.Vector3(-m.nx * 0.03, 0, -m.nz * 0.03));
      frame.quaternion.copy(mesh.quaternion);
      group.add(frame, mesh);
      return { m, mesh };
    });
    const puddleMat = new THREE.MeshStandardMaterial({ color: 0x0a0e16, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.85 });
    this.puddleMeshes = map.puddles.map((p) => {
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(p.r, 24), puddleMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(p.x, 0.02, p.z);
      group.add(mesh);
      return { p, mesh };
    });
    this.mirrorReflector = null;
    this.puddleReflector = null;
    if (this.opts.reflect) {
      const res = this.opts.reflectRes;
      this.mirrorReflector = new Reflector(new THREE.PlaneGeometry(1, 1), { textureWidth: res, textureHeight: res, color: 0x8899aa, clipBias: 0.003 });
      this.mirrorReflector.visible = false;
      group.add(this.mirrorReflector);
      this.puddleReflector = new Reflector(new THREE.CircleGeometry(1, 24), { textureWidth: res, textureHeight: res, color: 0x445566, clipBias: 0.003 });
      this.puddleReflector.rotation.x = -Math.PI / 2;
      this.puddleReflector.visible = false;
      group.add(this.puddleReflector);
    }

    // Zone wall
    this.zoneUniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xff2050) } };
    const zoneMat = new THREE.ShaderMaterial({
      uniforms: this.zoneUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          float stripes = smoothstep(0.4, 0.5, fract(vUv.x * 120.0 + vUv.y * 4.0 - uTime * 0.6)) * 0.35;
          float fade = pow(1.0 - vUv.y, 1.6);
          float base = 0.25 + 0.75 * smoothstep(0.0, 0.08, 1.0 - vUv.y) * fade;
          float scan = smoothstep(0.02, 0.0, abs(fract(vUv.y * 3.0 - uTime * 0.25) - 0.5)) * 0.4;
          gl_FragColor = vec4(uColor, (base * 0.3 + stripes * fade * 0.6 + scan * fade) * 0.8);
        }`,
    });
    this.zone = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 9, 128, 1, true), zoneMat);
    this.zone.position.y = 1.5;
    this.zone.renderOrder = 5;
    group.add(this.zone);
    this.nextZone = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 128), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    this.nextZone.rotation.x = -Math.PI / 2;
    this.nextZone.position.y = 0.05;
    group.add(this.nextZone);
    this.zoneState = null;

  }

  makeLabelMaterial(text) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(5,3,10,0.72)';
    g.strokeStyle = 'rgba(62,199,255,0.6)';
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(14, 8, 228, 64, 14);
    g.fill();
    g.stroke();
    g.font = '700 46px "Share Tech Mono", monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(180,170,210,0.55)';
    g.fillText(text, 128, 42);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false });
  }

  // --------------------------------------------------------------------------- dynamic state
  setZone(z) {
    this.zoneState = z;
  }

  setDoors(state) {
    if (!state || state === this.doorState) return;
    this.doorState = state;
    for (const o of this.doorObjs) {
      const c = state[o.d.id];
      o.target = c === '1' ? 1 : 0;
      const locked = c === '2';
      o.light.material.color.set(locked ? 0xff2040 : 0x33ff88);
      o.halo.material.opacity = locked ? 0.9 : 0;
    }
  }

  setLights(state) {
    if (!state || state === this.lightState) return;
    this.lightState = state;
    this.refreshLampColors();
  }

  refreshLampColors() {
    const lo = this.lightsOutPhase === 'on';
    const off = this._lampOff || (this._lampOff = new THREE.Color(0x15151a));
    for (const s of this.lampSources) {
      if (s.kind !== 'ceiling') continue;
      this.ceilMesh.setColorAt(s.idx, !lo && this.lightState[s.roomId] !== '0' ? s.color : off);
    }
    if (this.ceilMesh.instanceColor) this.ceilMesh.instanceColor.needsUpdate = true;
    const on = this._swOn || (this._swOn = new THREE.Color(0xffe080));
    const offSw = this._swOff || (this._swOff = new THREE.Color(0x553322));
    this.map.switches.forEach((sw, i) => this.switchMesh.setColorAt(i, this.lightState[sw.roomId] !== '0' ? on : offSw));
    if (this.switchMesh.instanceColor) this.switchMesh.instanceColor.needsUpdate = true;
    const em = lo ? (this._emOn || (this._emOn = new THREE.Color(0xff2030))) : (this._emOff || (this._emOff = new THREE.Color(0x401010)));
    this.emergency.forEach((e, i) => this.emMesh.setColorAt(i, em));
    if (this.emMesh.instanceColor) this.emMesh.instanceColor.needsUpdate = true;
    for (const s of this.lampSources) {
      if (s.kind === 'post') {
        s.bulb.material.color.set(lo ? 0x222222 : this.theme.lamp);
        s.halo.visible = !lo;
      }
    }
    for (const sg of this.signs) sg.visible = !lo;
  }

  setLightsOut(phase) {
    if (phase === this.lightsOutPhase) return;
    this.lightsOutPhase = phase;
    this.refreshLampColors();
  }

  /** Shared pickup parts, created once per kind (no geometry/material creation during play). */
  pickupKit(key) {
    let kit = this.pkCache.get(key);
    if (kit) return kit;
    if (!this.pkGeo) {
      this.pkGeo = {
        frame: new THREE.OctahedronGeometry(0.55, 0),
        beam: new THREE.CylinderGeometry(0.05, 0.4, 5, 12, 1, true),
        dome: new THREE.SphereGeometry(0.32, 10, 8, 0, Math.PI * 2, 0, Math.PI / 1.7),
        tip: new THREE.ConeGeometry(0.16, 0.4, 8),
        trim: new THREE.TorusGeometry(0.3, 0.025, 6, 24),
      };
    }
    if (key === 'hood') {
      const color = '#5effa1';
      kit = {
        color,
        body: new THREE.MeshStandardMaterial({ color: 0x15121d, emissive: color, emissiveIntensity: 0.25, side: THREE.DoubleSide, flatShading: true }),
        trim: new THREE.MeshBasicMaterial({ color }),
      };
    } else {
      const def = ITEMS[key] || { icon: '?', color: '#fff', rarity: 'common' };
      const ring = RARITY_COLOR[def.rarity];
      kit = {
        color: def.color,
        icon: new THREE.SpriteMaterial({ map: iconTexture(def.icon, ring), transparent: true, depthWrite: false }),
        frame: new THREE.MeshBasicMaterial({ color: ring, wireframe: true, transparent: true, opacity: 0.8 }),
      };
    }
    kit.halo = new THREE.SpriteMaterial({ map: glowTexture(), color: kit.color, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
    kit.beam = new THREE.MeshBasicMaterial({ color: kit.color, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending });
    this.pkCache.set(key, kit);
    return kit;
  }

  makePickup(pk) {
    const g = new THREE.Group();
    const G = this.pkGeo || (this.pickupKit('hood'), this.pkGeo);
    if (pk.type === 'item') {
      const kit = this.pickupKit(pk.item);
      const icon = new THREE.Sprite(kit.icon);
      icon.scale.set(0.8, 0.8, 1);
      const frame = new THREE.Mesh(G.frame, kit.frame);
      g.add(icon, frame);
      g.userData.spin = [frame];
      g.userData.kit = kit;
    } else {
      const kit = this.pickupKit('hood');
      const hood = new THREE.Group();
      const dome = new THREE.Mesh(G.dome, kit.body);
      const tip = new THREE.Mesh(G.tip, kit.body);
      tip.position.set(0, 0.25, -0.2);
      tip.rotation.x = -0.9;
      const trim = new THREE.Mesh(G.trim, kit.trim);
      trim.rotation.x = Math.PI / 2;
      trim.position.y = -0.05;
      hood.add(dome, tip, trim);
      g.add(hood);
      g.userData.spin = [hood];
      g.userData.kit = kit;
    }
    const kit = g.userData.kit;
    const halo = new THREE.Sprite(kit.halo);
    halo.scale.set(2, 2, 1);
    const beam = new THREE.Mesh(G.beam, kit.beam);
    beam.position.y = 1.8;
    g.add(halo, beam);
    g.userData.baseY = (pk.level ?? 0) * H + 1;
    g.position.set(pk.x, g.userData.baseY, pk.z);
    return g;
  }

  setPickups(list) {
    if (!list) return;
    const ids = new Set();
    for (const pk of list) {
      ids.add(pk.id);
      if (!this.pickupObjs.has(pk.id)) {
        const o = this.makePickup(pk);
        this.group.add(o);
        this.pickupObjs.set(pk.id, o);
      }
    }
    for (const [id, o] of this.pickupObjs) {
      if (!ids.has(id)) {
        this.group.remove(o);
        this.pickupObjs.delete(id);
      }
    }
  }

  /** 0 = normal, 1 = pitch black */
  setDarkness(target, dt) {
    this.darkness += (target - this.darkness) * Math.min(1, dt * 3);
    const k = 1 - this.darkness * 0.94;
    this.hemi.intensity = this.baseHemi * k;
    this.moon.intensity = this.baseMoon * k;
  }

  updateLights(camPos, t, flashlights) {
    const lo = this.lightsOutPhase === 'on';
    const warn = this.lightsOutPhase === 'warn';
    const cands = [];
    if (!lo) {
      for (const s of this.lampSources) {
        if (s.kind === 'ceiling' && this.lightState[s.roomId] === '0') continue;
        cands.push(s);
      }
    } else for (const e of this.emergency) cands.push(e);
    for (const c of cands) c._d = (c.x - camPos.x) ** 2 + (c.y - camPos.y) ** 2 * 3 + (c.z - camPos.z) ** 2;
    cands.sort((a, b) => a._d - b._d);
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i];
      const c = cands[i];
      if (!c) {
        l.intensity = 0;
        continue;
      }
      l.position.set(c.x, c.y, c.z);
      l.color.copy(c.color);
      l.distance = c.range;
      let k = 1;
      if (warn) k = Math.random() < 0.5 ? 0.1 : 1;
      else if (this.theme.flicker && Math.random() < this.theme.flicker * 0.5) k = 0.3;
      if (c.kind === 'emergency') k = 0.6 + 0.4 * Math.sin(t * 6);
      l.intensity = c.base * k;
    }
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      const f = flashlights[i];
      if (!f) {
        s.intensity = 0;
        continue;
      }
      s.intensity = 45;
      s.position.set(f.x, f.y, f.z);
      s.target.position.set(f.x + f.dirX * 6, f.y - 0.7 + (f.dirY || 0) * 6, f.z + f.dirZ * 6);
    }
  }

  /** Live reflections only right next to a mirror (in front of you) or a puddle. */
  updateReflectors(camPos, level, dir, off = false) {
    if (!this.mirrorReflector) return;
    if (off) {
      this.mirrorReflector.visible = false;
      this.puddleReflector.visible = false;
      return;
    }
    let best = null;
    let bd = 16;
    for (const o of this.mirrorMeshes) {
      if (o.m.level !== level) continue;
      const dx = o.mesh.position.x - camPos.x;
      const dz = o.mesh.position.z - camPos.z;
      const d = dx * dx + dz * dz;
      if (d >= bd || (dir && dx * dir.x + dz * dir.z < 0)) continue;
      bd = d;
      best = o;
    }
    const R = this.mirrorReflector;
    if (best) {
      R.visible = true;
      R.position.copy(best.mesh.position);
      R.position.x += best.m.nx * 0.005;
      R.position.z += best.m.nz * 0.005;
      R.quaternion.copy(best.mesh.quaternion);
      R.scale.set(best.m.w, best.m.y1 - best.m.y0, 1);
    } else R.visible = false;
    let bp = null;
    bd = 25;
    if (level === 0) {
      for (const o of this.puddleMeshes) {
        const d = (o.p.x - camPos.x) ** 2 + (o.p.z - camPos.z) ** 2;
        if (d < bd) {
          bd = d;
          bp = o;
        }
      }
    }
    const P = this.puddleReflector;
    if (bp) {
      P.visible = true;
      P.position.set(bp.p.x, 0.025, bp.p.z);
      P.scale.set(bp.p.r, bp.p.r, 1);
    } else P.visible = false;
  }

  cull(camPos, maxD) {
    const m2 = maxD * maxD;
    const far = (x, z) => (x - camPos.x) ** 2 + (z - camPos.z) ** 2 > m2;
    for (const o of this.doorObjs) {
      const f = far(o.pivot.position.x, o.pivot.position.z);
      o.pivot.visible = !f;
      o.light.parent.visible = !f;
    }
    for (const s of this.lampSources) if (s.kind === 'post') s.post.visible = !far(s.x, s.z);
    for (const o of this.pickupObjs.values()) o.visible = !far(o.position.x, o.position.z);
    for (const d of this.decoys) d.visible = (d.position.x - camPos.x) ** 2 + (d.position.z - camPos.z) ** 2 < Math.min(m2, 1600);
  }

  update(dt, t, camPos, playerLevel) {
    this.zoneUniforms.uTime.value = t;
    const z = this.zoneState;
    if (z) {
      const r = Math.max(0.01, z.r);
      const cur = this.zone.scale.x;
      const nr = cur + (r - cur) * Math.min(1, dt * 8);
      this.zone.scale.set(nr, 1, nr);
      this.zone.position.x += (z.x - this.zone.position.x) * Math.min(1, dt * 8);
      this.zone.position.z += (z.z - this.zone.position.z) * Math.min(1, dt * 8);
      this.nextZone.visible = z.phase !== 'final' && z.tr < z.r;
      this.nextZone.scale.set(Math.max(0.01, z.tr), Math.max(0.01, z.tr), 1);
      this.nextZone.position.x = z.tx;
      this.nextZone.position.z = z.tz;
    }
    for (const o of this.pickupObjs.values()) {
      o.position.y = o.userData.baseY + Math.sin(t * 2 + o.position.x) * 0.15;
      for (const s of o.userData.spin) s.rotation.y += dt * 1.5;
    }
    for (const o of this.doorObjs) {
      if (Math.abs(o.target - o.angle) < 0.001) continue;
      o.angle += (o.target - o.angle) * Math.min(1, dt * 8);
      o.pivot.rotation.y = -o.angle * Math.PI * 0.5;
    }
    this.moon.position.set(camPos.x - 20, 40, camPos.z - 12);
    this.moon.target.position.set(camPos.x, 0, camPos.z);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const g of Object.values(this.pkGeo || {})) g.dispose();
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    this.mirrorReflector?.dispose?.();
    this.puddleReflector?.dispose?.();
  }
}
