// Procedural canvas textures (no asset files). They're mostly light/neutral "detail" maps:
// the actual colour comes from vertex colours, so one texture serves many tints.
import * as THREE from 'three';

const cache = new Map();
let rng = 1;
const rnd = () => {
  rng = (rng * 16807) % 2147483647;
  return rng / 2147483647;
};

function make(key, size, draw, { repeat = true } = {}) {
  if (cache.has(key)) return cache.get(key);
  rng = 12345 + key.length * 97;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  cache.set(key, t);
  return t;
}

function noise(g, s, n, lo, hi, alpha = 0.25, size = [1, 3]) {
  for (let i = 0; i < n; i++) {
    const v = lo + rnd() * (hi - lo);
    g.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    const w = size[0] + rnd() * (size[1] - size[0]);
    g.fillRect(rnd() * s, rnd() * s, w, w);
  }
}

export const TEX = {
  // Horizontal wood siding / clapboard
  siding: () => make('siding', 256, (g, s) => {
    g.fillStyle = '#e6e6e6';
    g.fillRect(0, 0, s, s);
    const rows = 8;
    for (let r = 0; r < rows; r++) {
      const y = (r * s) / rows;
      const grd = g.createLinearGradient(0, y, 0, y + s / rows);
      grd.addColorStop(0, 'rgba(255,255,255,0.35)');
      grd.addColorStop(0.85, 'rgba(0,0,0,0.0)');
      grd.addColorStop(1, 'rgba(0,0,0,0.35)');
      g.fillStyle = grd;
      g.fillRect(0, y, s, s / rows);
    }
    noise(g, s, 1500, 140, 220, 0.12);
  }),
  // Smooth plaster for interiors and ceilings
  plaster: () => make('plaster', 256, (g, s) => {
    g.fillStyle = '#ececec';
    g.fillRect(0, 0, s, s);
    noise(g, s, 2500, 190, 255, 0.18, [1, 4]);
  }),
  // Brick / stone
  brick: () => make('brick', 256, (g, s) => {
    g.fillStyle = '#8a8a8a';
    g.fillRect(0, 0, s, s);
    const bh = s / 8;
    const bw = s / 4;
    for (let r = 0; r < 8; r++) {
      for (let c = -1; c < 5; c++) {
        const x = c * bw + (r % 2 ? bw / 2 : 0);
        const v = 175 + rnd() * 70;
        g.fillStyle = `rgb(${v},${v * 0.97},${v * 0.95})`;
        g.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
      }
    }
    noise(g, s, 1200, 60, 160, 0.2);
  }),
  // Roof shingles
  shingles: () => make('shingles', 256, (g, s) => {
    g.fillStyle = '#9a9a9a';
    g.fillRect(0, 0, s, s);
    const rh = s / 8;
    const tw = s / 6;
    for (let r = 0; r < 8; r++) {
      for (let c = -1; c < 7; c++) {
        const x = c * tw + (r % 2 ? tw / 2 : 0);
        const v = 160 + rnd() * 80;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.beginPath();
        g.roundRect(x + 2, r * rh + 2, tw - 4, rh, [0, 0, 8, 8]);
        g.fill();
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(x + 2, r * rh + rh - 3, tw - 4, 3);
      }
    }
  }),
  // Wooden floor planks
  planks: () => make('planks', 256, (g, s) => {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const v = 190 + rnd() * 50;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(0, (i * s) / n, s, s / n);
      for (let k = 0; k < 14; k++) {
        g.strokeStyle = `rgba(0,0,0,${0.05 + rnd() * 0.08})`;
        g.beginPath();
        const y = (i * s) / n + rnd() * (s / n);
        g.moveTo(0, y);
        g.bezierCurveTo(s * 0.3, y + rnd() * 6 - 3, s * 0.6, y + rnd() * 6 - 3, s, y);
        g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(0, (i * s) / n, s, 2);
      g.fillRect(((i * 97) % 5) * (s / 5), (i * s) / n, 2, s / n);
    }
  }),
  // Square tiles with grout
  tiles: () => make('tiles', 256, (g, s) => {
    g.fillStyle = '#9c9c9c';
    g.fillRect(0, 0, s, s);
    const n = 4;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = 220 + rnd() * 30;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect((x * s) / n + 3, (y * s) / n + 3, s / n - 6, s / n - 6);
      }
    }
  }),
  // Polished marble (fountain, bathtubs)
  marble: () => make('marble', 512, (g, s) => {
    g.fillStyle = '#f2f2f2';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = `rgba(120,120,130,${0.08 + rnd() * 0.12})`;
      g.lineWidth = 1 + rnd() * 2;
      g.beginPath();
      let x = rnd() * s;
      let y = rnd() * s;
      g.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += rnd() * 120 - 60;
        y += rnd() * 120 - 40;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 3;
    g.strokeRect(0, 0, s, s);
  }),
  concrete: () => make('concrete', 256, (g, s) => {
    g.fillStyle = '#c8c8c8';
    g.fillRect(0, 0, s, s);
    noise(g, s, 5000, 120, 230, 0.2, [1, 3]);
  }),
  // Exterior panels with vertical seams
  panel: () => make('panel', 256, (g, s) => {
    g.fillStyle = '#ededed';
    g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(0, 0, 3, s);
    g.fillRect(s / 2, 0, 2, s);
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.fillRect(4, 0, 2, s);
    noise(g, s, 800, 200, 255, 0.1);
  }),
  woodgrain: () => make('woodgrain', 256, (g, s) => {
    g.fillStyle = '#d8d8d8';
    g.fillRect(0, 0, s, s);
    for (let k = 0; k < 60; k++) {
      g.strokeStyle = `rgba(0,0,0,${0.04 + rnd() * 0.1})`;
      g.beginPath();
      const y = rnd() * s;
      g.moveTo(0, y);
      g.bezierCurveTo(s * 0.3, y + rnd() * 10 - 5, s * 0.7, y + rnd() * 10 - 5, s, y);
      g.stroke();
    }
  }),
  fabric: () => make('fabric', 128, (g, s) => {
    g.fillStyle = '#dcdcdc';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < s; i += 4) {
      g.fillStyle = 'rgba(0,0,0,0.06)';
      g.fillRect(i, 0, 1, s);
      g.fillRect(0, i, s, 1);
    }
  }),
  metal: () => make('metal', 128, (g, s) => {
    g.fillStyle = '#cfd3d8';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 200; i++) {
      g.fillStyle = `rgba(255,255,255,${rnd() * 0.15})`;
      g.fillRect(0, rnd() * s, s, 1);
    }
  }),
  grass: () => make('grass', 512, (g, s) => {
    g.fillStyle = '#5f7a4a';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 14000; i++) {
      const k = 0.7 + rnd() * 0.6;
      g.fillStyle = `rgba(${(70 * k) | 0},${(110 * k) | 0},${(55 * k) | 0},0.8)`;
      g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 2 + rnd() * 4);
    }
    for (let i = 0; i < 18; i++) {
      g.fillStyle = 'rgba(90,75,50,0.18)';
      g.beginPath();
      g.ellipse(rnd() * s, rnd() * s, 20 + rnd() * 50, 10 + rnd() * 30, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
  }),
  asphalt: () => make('asphalt', 256, (g, s) => {
    g.fillStyle = '#3a3c40';
    g.fillRect(0, 0, s, s);
    noise(g, s, 6000, 30, 110, 0.35, [1, 2]);
    // dashed centre line along v
    g.fillStyle = 'rgba(235,215,120,0.85)';
    g.fillRect(s / 2 - 3, 20, 6, s / 2 - 40);
  }),
  sidewalk: () => make('sidewalk', 128, (g, s) => {
    g.fillStyle = '#9a9a9a';
    g.fillRect(0, 0, s, s);
    const n = 2;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = 170 + rnd() * 30;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect((x * s) / n + 2, (y * s) / n + 2, s / n - 4, s / n - 4);
    }
  }),
};

/** Text sign texture (neon store signs), 512x128. */
export function signTexture(text, color) {
  const key = `sign:${text}:${color}`;
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  g.font = '800 62px Orbitron, "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 26;
  g.fillStyle = color;
  g.fillText(text, 256, 66, 480);
  g.shadowBlur = 6;
  g.fillStyle = '#ffffff';
  g.fillText(text, 256, 66, 480);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}
