import * as THREE from 'three';
import { glowTexture, iconTexture } from './world.js';

const SCRAMBLE_MS = 380;

// 'overhead' (billboard above the head) or 'face' (a plate on the forehead, only readable from the front).
let codeStyle = 'overhead';
export function setCodeStyle(style) {
  codeStyle = style === 'face' ? 'face' : 'overhead';
}
const PLATE_W = 0.62; // forehead plate width up close (m)

/** Billboard text sprite backed by a canvas. */
class Label {
  constructor(w, h, scale) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.sprite.scale.set(scale, (scale * h) / w, 1);
    this.sprite.renderOrder = 10;
    this.baseScale = scale;
  }
}

function drawName(label, name, color) {
  const { ctx, canvas } = label;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '600 34px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = Math.min(canvas.width - 8, ctx.measureText(name).width + 28);
  ctx.fillStyle = 'rgba(5,3,10,0.6)';
  ctx.beginPath();
  ctx.roundRect((canvas.width - w) / 2, 6, w, canvas.height - 12, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect((canvas.width - w) / 2 + 8, canvas.height - 12, w - 16, 3);
  ctx.fillStyle = '#fff';
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);
  label.tex.needsUpdate = true;
}

class CodeLabel extends Label {
  constructor(isSelf) {
    super(256, 96, 1.5);
    this.isSelf = isSelf;
    this.code = null; // '4?2?' or null
    this.digits = ['?', '?', '?', '?'];
    this.scramble = [0, 0, 0, 0];
    this.typing = false;
    this.dirty = true;
  }

  set(code, typing) {
    if (code === this.code && typing === this.typing) return;
    const next = code ? [...code] : ['?', '?', '?', '?'];
    const now = performance.now();
    for (let i = 0; i < 4; i++) {
      if (next[i] !== '?' && next[i] !== this.digits[i]) this.scramble[i] = now + SCRAMBLE_MS;
    }
    this.digits = next;
    this.code = code;
    this.typing = typing;
    this.dirty = true;
  }

  draw() {
    const now = performance.now();
    const animating = this.scramble.some((t) => t > now);
    if (!this.dirty && !animating) return;
    this.dirty = animating;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const full = this.digits.every((d) => d !== '?');
    ctx.fillStyle = 'rgba(5,3,10,0.72)';
    ctx.strokeStyle = this.isSelf ? 'rgba(255,255,255,0.25)' : full ? '#ff3860' : 'rgba(62,199,255,0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(14, 8, canvas.width - 28, 64, 14);
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 46px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      let ch = this.digits[i];
      const scr = this.scramble[i] > now;
      if (scr) ch = String(Math.floor(Math.random() * 10));
      const x = 50 + i * 52;
      if (ch === '?') ctx.fillStyle = this.isSelf ? 'rgba(255,255,255,0.45)' : 'rgba(180,170,210,0.55)';
      else ctx.fillStyle = scr ? '#3ec7ff' : full ? '#ff5c7c' : '#ffffff';
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = ch === '?' ? 0 : 12;
      ctx.fillText(ch, x, 42);
    }
    ctx.shadowBlur = 0;
    if (this.typing) {
      ctx.font = '700 18px Rajdhani, sans-serif';
      ctx.fillStyle = '#ffd23f';
      ctx.fillText('▮ TYPING ▮', canvas.width / 2, 86);
    }
    this.tex.needsUpdate = true;
  }
}

export class Character {
  constructor({ id, name, color }, { isSelf = false } = {}) {
    this.id = id;
    this.color = color;
    this.isSelf = isSelf;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    const col = new THREE.Color(color);
    this.mats = [];
    const mat = (opts) => {
      const m = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1, flatShading: true, ...opts });
      this.mats.push(m);
      return m;
    };
    const bodyMat = mat({ color: col, emissive: col, emissiveIntensity: 0.12 });
    const darkMat = mat({ color: 0x15121d });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.55, 3, 8), bodyMat);
    torso.position.y = 1.05;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.27, 1), bodyMat);
    head.position.y = 1.67;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.11, 0.1), mat({ color: 0x050308, emissive: col, emissiveIntensity: 0.9 }));
    visor.position.set(0, 1.7, 0.22);
    const legGeo = new THREE.CapsuleGeometry(0.11, 0.42, 2, 6);
    this.legL = new THREE.Mesh(legGeo, darkMat);
    this.legR = new THREE.Mesh(legGeo, darkMat);
    const hipL = new THREE.Group();
    const hipR = new THREE.Group();
    hipL.position.set(-0.14, 0.62, 0);
    hipR.position.set(0.14, 0.62, 0);
    this.legL.position.y = -0.3;
    this.legR.position.y = -0.3;
    hipL.add(this.legL);
    hipR.add(this.legR);
    this.hipL = hipL;
    this.hipR = hipR;
    const armGeo = new THREE.CapsuleGeometry(0.08, 0.4, 2, 6);
    const shL = new THREE.Group();
    const shR = new THREE.Group();
    shL.position.set(-0.42, 1.3, 0);
    shR.position.set(0.42, 1.3, 0);
    const armL = new THREE.Mesh(armGeo, bodyMat);
    const armR = new THREE.Mesh(armGeo, bodyMat);
    armL.position.y = -0.25;
    armR.position.y = -0.25;
    shL.add(armL);
    shR.add(armR);
    this.shL = shL;
    this.shR = shR;
    this.body.add(torso, head, visor, hipL, hipR, shL, shR);
    for (const m of [torso, head, this.legL, this.legR, armL, armR]) m.castShadow = true;

    // Hood (pickup)
    this.hood = new THREE.Group();
    const hoodMat = mat({ color: 0x0d0b12, emissive: 0x5effa1, emissiveIntensity: 0.15, side: THREE.DoubleSide });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.33, 10, 8, 0, Math.PI * 2, 0, Math.PI / 1.65), hoodMat);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.45, 8), hoodMat);
    tip.position.set(0, 0.2, -0.25);
    tip.rotation.x = -1.1;
    const trim = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.025, 6, 24), new THREE.MeshBasicMaterial({ color: 0x5effa1 }));
    trim.rotation.x = Math.PI / 2 - 0.25;
    trim.position.set(0, -0.04, 0.03);
    this.hood.add(dome, tip, trim);
    this.hood.position.y = 1.7;
    this.hood.visible = false;
    this.body.add(this.hood);

    // Shimmer (code shuffled)
    const n = 40;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * 0.6;
      pos[i * 3 + 1] = Math.random() * 2;
      pos[i * 3 + 2] = Math.sin(a) * 0.6;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.shimmer = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xff5ec4, size: 0.12, map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.shimmer.visible = false;
    this.root.add(this.shimmer);

    // Revealed (penalty) beacon
    this.beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 30, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xff2050, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.beacon.position.y = 15;
    this.beacon.visible = false;
    this.root.add(this.beacon);

    // Bounty: gold ring + icon visible from far away (drawn on top of everything)
    this.bounty = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.05, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffc83d }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;
    const goldGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffc83d, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    goldGlow.scale.set(3, 3.6, 1);
    goldGlow.position.y = 1.1;
    this.bountyIcon = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTexture('💰', '#ffc83d'), transparent: true, depthTest: false, depthWrite: false }));
    this.bountyIcon.scale.set(0.9, 0.9, 1);
    this.bountyIcon.position.y = 3.45;
    this.bountyIcon.renderOrder = 20;
    this.bounty.add(ring, goldGlow, this.bountyIcon);
    this.bounty.visible = false;
    this.root.add(this.bounty);

    // Flashlight beam (visible cone gives the holder away)
    const cone = new THREE.ConeGeometry(2.2, 9, 20, 1, true);
    cone.translate(0, -4.5, 0);
    cone.rotateX(-Math.PI / 2);
    this.beam = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0xfff3c0, transparent: true, opacity: 0.09, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    this.beam.position.y = 1.3;
    this.beam.visible = false;
    this.beamPivot = new THREE.Group();
    this.beamPivot.add(this.beam);
    this.root.add(this.beamPivot);

    // Labels
    this.nameLabel = new Label(256, 56, 1.4);
    drawName(this.nameLabel, name, color);
    this.nameLabel.sprite.position.y = 2.25;
    this.codeLabel = new CodeLabel(isSelf);
    this.codeLabel.sprite.position.y = 2.75;
    this.root.add(this.nameLabel.sprite, this.codeLabel.sprite);
    if (isSelf) this.nameLabel.sprite.visible = false;
    // Face-to-face mode: the code is a one-sided plate on the forehead instead of a billboard, so it
    // turns with the head and can't be seen from behind.
    this.face = codeStyle === 'face';
    this.plate = null;
    if (this.face) {
      this.codeLabel.sprite.visible = false;
      this.plate = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 96 / 256),
        new THREE.MeshBasicMaterial({ map: this.codeLabel.tex, transparent: true, depthWrite: false, side: THREE.FrontSide }),
      );
      this.plate.position.set(0, 1.88, 0.3);
      this.plate.scale.set(PLATE_W, PLATE_W, 1);
      this.plate.renderOrder = 10;
      this.root.add(this.plate);
    }

    this.walkPhase = 0;
    this.ghost = false;
    this.yaw = 0;
    this.shadowOn = true;
    this.castMeshes = [];
    this.body.traverse((o) => { if (o.isMesh && o.castShadow) this.castMeshes.push(o); });
  }

  /** Cheap LOD: far characters skip the body (fog hides it anyway) and shadows. */
  setLod(far, shadow) {
    this.body.visible = !far;
    this.nameLabel.sprite.visible = !far && !this.isSelf;
    this.codeObj.visible = !far && !this.ghost;
    if (shadow !== this.shadowOn && !this.ghost) {
      this.shadowOn = shadow;
      for (const m of this.castMeshes) m.castShadow = shadow;
    }
  }

  setGhost(on) {
    if (this.ghost === on) return;
    this.ghost = on;
    for (const m of this.mats) {
      m.transparent = on;
      m.opacity = on ? 0.3 : 1;
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
    this.codeObj.visible = !on;
    this.body.traverse((o) => { if (o.isMesh) o.castShadow = !on; });
  }

  /** The object that shows the code: the forehead plate in face-to-face mode, else the overhead billboard. */
  get codeObj() {
    return this.plate || this.codeLabel.sprite;
  }

  setCode(code, typing = false) {
    this.codeLabel.set(code, typing);
  }

  update(dt, s, camera) {
    // s: { moving, crouch, hood, shimmer, revealed, hidden(locker) }
    const speed = s.crouch ? 6 : 10;
    if (s.moving) this.walkPhase += dt * speed;
    else this.walkPhase *= 0.85;
    const sw = Math.sin(this.walkPhase) * (s.moving ? 0.7 : 0);
    this.hipL.rotation.x = sw;
    this.hipR.rotation.x = -sw;
    this.shL.rotation.x = -sw * 0.8;
    this.shR.rotation.x = sw * 0.8;
    const targetSy = s.crouch ? 0.72 : 1;
    this.body.scale.y += (targetSy - this.body.scale.y) * Math.min(1, dt * 10);
    this.body.position.y = this.ghost ? Math.sin(performance.now() / 400) * 0.15 : Math.abs(Math.sin(this.walkPhase)) * 0.05;
    this.hood.visible = !!s.hood;
    this.shimmer.visible = !!s.shimmer;
    if (s.shimmer) this.shimmer.rotation.y += dt * 4;
    this.beacon.visible = !!s.revealed;
    this.root.visible = !s.hidden;
    this.bounty.visible = !!s.bounty;
    if (s.bounty) this.bounty.rotation.y += dt * 1.5;
    this.beam.visible = !!s.flashlight;
    if (s.flashlight) this.beamPivot.rotation.y = (s.flashYaw ?? 0) - this.root.rotation.y;
    if (s.seated) {
      this.body.scale.y = 0.8;
      this.hipL.rotation.x = this.hipR.rotation.x = -1.3;
    }
    const labelY = s.crouch ? 0.45 : 0;
    this.nameLabel.sprite.position.y = 2.25 - labelY;
    this.codeLabel.sprite.position.y = 2.75 - labelY;
    if (this.plate) this.plate.position.y = 1.88 * this.body.scale.y + this.body.position.y; // follows crouch / sitting
    // Keep labels readable at distance
    if (camera) {
      const d = camera.position.distanceTo(this.root.position);
      const k = 1 + Math.max(0, d - 8) * 0.035;
      if (this.plate) {
        // Grows faster than the billboard: a forehead plate is small, and it still has to be readable at range
        const kp = 1 + Math.max(0, d - 4) * 0.07;
        this.plate.scale.set(PLATE_W * kp, PLATE_W * kp, 1);
      }
      this.codeLabel.sprite.scale.set(this.codeLabel.baseScale * k, ((this.codeLabel.baseScale * 96) / 256) * k, 1);
      this.nameLabel.sprite.scale.set(this.nameLabel.baseScale * k, ((this.nameLabel.baseScale * 56) / 256) * k, 1);
    }
    this.codeLabel.draw();
  }

  dispose() {
    this.root.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) {
        o.material.map?.dispose?.();
        o.material.dispose();
      }
    });
  }
}
