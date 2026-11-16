import * as THREE from 'three';
import {
  CROUCH_MULT, EYE_HEIGHT, GHOST_SPEED, KILLBOX_MULT, LEVEL_HEIGHT, PLAYER_RADIUS, TICK_MS, VENT_DEPTH, WALK_SPEED,
} from '@shared/constants.js';
import { dist2D, moveWithCollisions, pointInBox } from '@shared/geometry.js';
import { ITEM_IDS, ITEMS } from '@shared/items.js';
import {
  defaultDoorState, defaultLightState, findInteractable, floorHeight, isDarkSpot, levelGeo, nearestDoor, predictedDoorState, prepareMap, resolveStairs,
} from '@shared/world.js';
import { clank, doorSound, footstep, ownStep, setAmbient, setListener, sfx, sirenFor } from '../audio.js';
import { escapeHtml } from '../ui/hud.js';
import { KillBox } from '../ui/killbox.js';
import { Character, setCodeStyle } from './character.js';
import { World } from './world.js';
import { getQuality } from '../quality.js';

const H = LEVEL_HEIGHT;
const INTERP_DELAY = 110; // ms behind server for remote players
const STEP_INTERVAL = 0.42;
const tmpV = new THREE.Vector3();
const vEye = new THREE.Vector3();
const vBack = new THREE.Vector3();
const vLook = new THREE.Vector3();
const vLook2 = new THREE.Vector3();
const vDir = new THREE.Vector3();
const LIGHT_FOG = 0.024; // the only weather: light fog (purely visual, it never changes what you can read)
const EYE = EYE_HEIGHT;
const DEATH_SCREEN_MS = 3000;
const SPIKE_MS = 50;

// Shared, never-disposed geometry for death effects (no geometry creation during play)
const FX_GEO = {
  shard: new THREE.TetrahedronGeometry(0.14),
  ring: new THREE.RingGeometry(0.2, 0.45, 32),
  pillar: new THREE.CylinderGeometry(0.5, 0.5, 20, 16, 1, true),
};
for (const g of Object.values(FX_GEO)) g.userData.shared = true;
const CROUCH_EYE = 1.15;
const INTRO_MS = 2600; // third-person intro, then glide into first person

export class Game {
  constructor({ socket, start, roster, hud, onToast }) {
    this.socket = socket;
    this.hud = hud;
    this.onToast = onToast;
    this.map = prepareMap(start.map);
    this.settings = start.settings;
    setCodeStyle(this.settings.codeStyle);
    this.selfId = start.selfId;
    this.roster = new Map(roster.map((p) => [p.id, p]));
    for (const p of start.players) this.roster.set(p.id, p);
    this.doorState = defaultDoorState(this.map);
    this.lightState = defaultLightState(this.map);
    this.pickups = [];

    // --- Three.js
    this.canvas = document.getElementById('scene');
    this.quality = getQuality();
    const q = this.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: q.pixelRatio >= 1.25, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadowSize > 0;
    this.renderer.shadowMap.type = q.shadowEvery === 1 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    // Shadows are the most expensive pass: refresh them every N frames instead of every frame
    this.renderer.shadowMap.autoUpdate = false;
    this.frameNo = 0;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.scene = new THREE.Scene();
    this.world = new World(this.scene, this.map, { lights: q.lights, spots: q.spots, reflect: q.reflect, reflectRes: q.reflectRes, shadowSize: q.shadowSize });
    const theme = this.world.theme;
    this.scene.background = new THREE.Color(theme.sky);
    this.fogBase = LIGHT_FOG;
    // Beyond this distance fog makes things ~invisible: cull them (codes aren't readable that far anyway)
    this.cullDist = Math.min(60, Math.sqrt(Math.log(1 / 0.04)) / this.fogBase);
    this.scene.fog = new THREE.FogExp2(theme.fogColor, this.fogBase);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 220);
    this.introStart = performance.now();
    this.headBob = 0;
    this.eyeY = EYE;
    this.fpsEl = document.getElementById('fps');
    this.fpsFrames = 0;
    this.fpsAt = performance.now();
    this.secCams = (this.map.security?.cameras || []).map((c) => {
      const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 120);
      cam.position.set(c.x, c.level * H + c.y, c.z);
      cam.lookAt(c.x + Math.sin(c.yaw) * Math.cos(c.pitch), c.level * H + c.y + Math.sin(c.pitch), c.z + Math.cos(c.yaw) * Math.cos(c.pitch));
      return cam;
    });

    // A small light that follows you so darkness isn't pitch black up close
    this.setupSecurityView();
    this.selfLight = new THREE.PointLight(0xa0b0ff, 0, 7, 1.5);
    this.scene.add(this.selfLight);

    // --- Local player
    this.self = {
      id: this.selfId,
      x: start.spawn.x, y: 0, z: start.spawn.z, yaw: start.spawn.yaw, level: start.spawn.level ?? 0,
      viewYaw: start.spawn.yaw + Math.PI, pitch: 0.05,
      alive: !start.spectator, crouch: false, locker: null, lockerLook: 0,
      moving: false, stepT: 0, penalty: this.settings.penaltyType, deathAfter: this.settings.deathAfter,
      dropMode: false, vent: null, ventSel: 0, ventInput: 0, watching: false,
      nameOf: (id) => this.roster.get(id)?.name || '???',
    };
    if (start.spectator) this.self.y = 12;
    const info = this.roster.get(this.selfId) || { id: this.selfId, name: 'You', color: '#fff' };
    this.selfChar = new Character(info, { isSelf: true });
    this.selfChar.setCode(null);
    this.scene.add(this.selfChar.root);
    if (!this.self.alive) this.selfChar.setGhost(true);

    this.chars = new Map();
    this.parked = new Map(); // characters of players currently not in snapshots (kept for reuse)
    this.buffers = new Map();
    this.flags = new Map();
    this.stepTimers = new Map();
    this.effects = [];
    this.spectateId = null;
    this.snap = null;
    this.timeOffset = null;
    this.keys = new Set();
    this.lastSend = 0;
    this.shake = 0;
    this.chatOpen = false;
    this.rewardOpen = false;
    this.running = true;
    this.lastFrame = performance.now();
    this.lastLightUpdate = 0;

    this.killbox = new KillBox(document.getElementById('killbox'), {
      onSubmit: (code) => this.socket.emit('kill', { code }, (res) => this.onKillResult(res)),
      onToggle: (open) => this.socket.emit('killbox', { open }),
    });
    this.killbox.reset();
    // A lobby text box (chat, settings) may still have keyboard focus: release it so keys reach the game
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();

    this.deathUntil = 0;
    this.pendingSpectate = null;
    this.deathPos = null;
    this.debugCam = null;
    this.initSpikeLogger();
    this.bindInput();
    this.bindNet();
    this.onResize();
    setAmbient(true);
    this.hud.setMapLabel(`${this.map.themeName || theme.name} · light fog`);
    if (start.spectator) {
      this.hud.announce('SPECTATING', 'You joined mid-round — you will play next round', '#3ec7ff', 4000);
      this.pendingSpectate = 'nearest';
      this.deathUntil = performance.now() + 600;
    } else this.hud.announce('FIND THEIR CODES', `${this.map.themeName} — yours floats above your head, only they can read it`, '#ff3860', 3800);
    if (import.meta.env.DEV) window.__ckGame = this; // dev-only: screenshots / spike checks
    this.loop = this.loop.bind(this);
    // Compile every shader before the first frame, then start the intro
    this.warmup().catch((err) => console.error('[ck] warm-up failed', err)).finally(() => {
      if (!this.running) return;
      this.introStart = performance.now();
      this.lastFrame = performance.now();
      requestAnimationFrame(this.loop);
    });
  }

  // ------------------------------------------------------------------ setup
  bindInput() {
    this.handlers = {
      resize: () => this.onResize(),
      keydown: (e) => this.onKeyDown(e),
      keyup: (e) => this.keys.delete(e.code),
      mousemove: (e) => this.onMouseMove(e),
      click: () => {
        if (this.chatOpen) return;
        if (document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock?.();
        else if (!this.self.alive && !this.deathUntil) this.cycleSpectate(1);
      },
      blur: () => this.keys.clear(),
    };
    window.addEventListener('resize', this.handlers.resize);
    window.addEventListener('keydown', this.handlers.keydown);
    window.addEventListener('keyup', this.handlers.keyup);
    window.addEventListener('mousemove', this.handlers.mousemove);
    window.addEventListener('blur', this.handlers.blur);
    this.canvas.addEventListener('click', this.handlers.click);
    const form = this.hud.chatBox.querySelector('form');
    this.chatSubmit = (e) => {
      e.preventDefault();
      const text = this.hud.chatInput.value.trim();
      if (text) this.socket.emit('chat', { text });
      this.closeChat();
    };
    form.addEventListener('submit', this.chatSubmit);
    this.chatKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeChat();
    };
    this.hud.chatInput.addEventListener('keydown', this.chatKey);
  }

  bindNet() {
    const s = this.socket;
    const H3 = (lv) => (lv ?? 0) * H;
    this.net = {
      snap: (d) => this.onSnap(d),
      correct: (d) => {
        this.self.x = d.x;
        this.self.z = d.z;
        if (d.level !== undefined) this.self.level = d.level;
        if (!this.self.alive) this.self.y = d.y;
        if (d.force && Number.isFinite(d.yaw)) {
          this.self.yaw = d.yaw;
          if (this.self.locker === null) this.self.viewYaw = d.yaw + Math.PI;
        }
      },
      feed: (f) => {
        this.hud.addFeed(f);
        if (f.cause === 'bounty') sfx.bounty();
        this.onSomeoneDied(f);
      },
      'fx:death': (d) => this.deathFx(d),
      'fx:shimmer': () => {},
      'fx:pickup': (d) => {
        if (d.by === this.selfId && d.type !== 'item') sfx.pickup();
      },
      'fx:door': (d) => {
        // Positional door sound: everybody nearby hears doors open and close
        const door = this.map.doors[d.id];
        if (!door) return;
        const cx = (door.minX + door.maxX) / 2;
        const cz = (door.minZ + door.maxZ) / 2;
        doorSound(cx, H3(door.level) + 1, cz, d.open);
        if (d.unsealed && dist2D(cx, cz, this.self.x, this.self.z) < 14) this.onToast('🗝 A sealed door was unlocked — it stays open for the rest of the round');
      },
      'fx:switch': () => sfx.click2(),
      'fx:vent': (d) => clank(d.x, H3(d.level), d.z),
      'you:died': (d) => this.onDied(d),
      'you:codeChanged': () => {
        sfx.codeChanged();
        this.hud.codeChanged();
        this.hud.announce('YOUR CODE HAS CHANGED', 'Everyone who memorised it is wrong now', '#ff5ec4');
      },
      'you:hood': (d) => {
        sfx.hood();
        this.hud.announce('HOODED', `2 of your digits are masked for ${Math.round(d.ms / 1000)}s`, '#5effa1');
      },
      'you:selfCode': (d) => {
        sfx.glimpse();
        this.hud.showSelfCode(d.code, d.ms);
        this.hud.announce('YOUR CODE', `Memorise it — visible for ${Math.round(d.ms / 1000)}s (top left)`, '#ffd23f', 2500);
      },
      glimpse: (d) => {
        sfx.glimpse();
        this.hud.showGlimpse(d.digit, d.pos, d.source);
      },
      'item:got': (d) => {
        sfx.item();
        this.hud.itemToast(d.item);
        this.hud.flashSlot(d.slot);
      },
      'item:full': (d) => this.onToast(`Inventory full — ${ITEMS[d.item]?.name || 'item'} left on the ground (Q to drop)`),
      'item:result': (d) => {
        if (d.ok) sfx.use();
        else sfx.locked();
        if (d.msg) this.onToast(d.msg);
      },
      interact: (d) => {
        if (d.msg) this.onToast(d.msg);
        if (!d.ok) sfx.locked();
      },
      'watch:end': (d) => {
        if (d.reason === 'nearby') this.hud.announce('SOMEONE IS TYPING NEARBY', "You've been startled out of the chair", '#ff3860', 2200);
        else if (d.reason === 'damage') this.hud.announce('THE ZONE IS HERE', '', '#ff3860', 1600);
        else if (d.reason === 'attacked') this.hud.announce('UNDER ATTACK', '', '#ff3860', 1600);
      },
      'bounty:reward': (d) => {
        sfx.bounty();
        document.exitPointerLock?.();
        this.rewardOpen = true;
        this.hud.showReward(d.ms, (choice) => this.chooseReward(choice));
      },
      announce: (a) => this.onAnnounce(a),
      'kill:result': () => {},
      chat: (m) => this.hud.addChat(m),
    };
    for (const [ev, fn] of Object.entries(this.net)) {
      if (ev === 'snap' || ev === 'correct') continue;
      this.net[ev] = (d) => {
        this.noteEvent(d && d.type && ev === 'announce' ? `announce:${d.type}` : ev);
        fn(d);
      };
    }
    for (const [ev, fn] of Object.entries(this.net)) s.on(ev, fn);
  }

  onAnnounce(a) {
    switch (a.type) {
      case 'lightsOutWarn':
        sirenFor(a.ms);
        this.hud.lightsOutWarning(a.ms);
        break;
      case 'lightsOut':
        sfx.lightsOut();
        this.hud.announce('LIGHTS OUT', 'Codes are only readable within 3m — unless you have a flashlight', '#ff5ec4');
        break;
      case 'lightsOn':
        this.hud.announce('LIGHTS BACK ON', '', '#ffd23f', 1500);
        break;
      case 'zoneShrink':
        sfx.zone();
        this.hud.announce('THE ZONE IS CLOSING', `Stage ${a.stage}`, '#ff3860');
        break;
      case 'bounty':
        sfx.bounty();
        if (a.id === this.selfId) this.hud.announce("YOU'RE THE BOUNTY", 'Everyone can see you on the minimap. Survive 30s for a reward.', '#ffd23f', 3200);
        else this.hud.announce(`BOUNTY: ${a.name}`, 'Kill them for a reward — they glow gold', '#ffd23f', 2600);
        break;
      case 'bountySurvived':
        this.hud.announce(`${a.name} SURVIVED THE BOUNTY`, '', '#ffd23f', 2000);
        break;
      case 'bountySurvivedYou':
        sfx.pickup();
        this.hud.announce('BOUNTY SURVIVED', `Reward: ${ITEMS[a.item]?.name || 'an item'}`, '#ffd23f', 2600);
        break;
      default:
        break;
    }
  }

  chooseReward(choice) {
    this.rewardOpen = false;
    this.hud.hideReward();
    this.socket.emit('bounty:choose', { choice });
    this.canvas.requestPointerLock?.();
  }

  setRoster(players) {
    for (const p of players) this.roster.set(p.id, p);
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  geo() {
    return levelGeo(this.map, this.self.level, this.doorState);
  }

  // ------------------------------------------------------------------ input
  openChat() {
    this.chatOpen = true;
    this.keys.clear();
    this.hud.chatBox.classList.add('open');
    document.exitPointerLock?.();
    setTimeout(() => this.hud.chatInput.focus(), 0);
  }

  closeChat() {
    this.chatOpen = false;
    this.hud.chatInput.value = '';
    this.hud.chatInput.blur();
    this.hud.chatBox.classList.remove('open');
    this.canvas.requestPointerLock?.();
  }

  onKeyDown(e) {
    if (this.chatOpen || !this.running) return;
    // Only a text box you can actually see (the in-game chat) takes the keys. A lobby box that kept
    // focus when the game started is hidden: drop its focus instead of swallowing every key.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      if (e.target.offsetParent !== null) return;
      e.target.blur();
    }
    if (this.rewardOpen) {
      if (e.code === 'KeyZ') this.chooseReward('reveal');
      else if (e.code === 'KeyX') this.chooseReward('shuffle');
      return;
    }
    const s = this.self;
    // Codes: just type the digits (top row or numpad, any keyboard layout). The 4th digit strikes.
    const digit = /^(Digit|Numpad)[0-9]$/.test(e.code) ? e.code.slice(-1) : null;
    if (digit !== null) {
      e.preventDefault();
      if (!e.repeat && s.alive && !s.vent) this.killbox.typeDigit(digit);
      return;
    }
    if (e.code === 'Backspace' || e.code === 'Delete' || e.code === 'Escape') {
      const used = e.code === 'Backspace' ? this.killbox.backspace() : this.killbox.clear();
      if (used) {
        e.preventDefault();
        return;
      }
    }
    if (e.repeat && ['KeyE', 'KeyR', 'KeyF', 'KeyT', 'KeyQ', 'KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
    if (s.dropMode && (e.code === 'KeyE' || e.code === 'KeyR')) {
      this.socket.emit('item:drop', { slot: e.code === 'KeyE' ? 0 : 1 });
      s.dropMode = false;
      return;
    }
    if (s.vent && s.alive) {
      const v = this.snap?.me.vent;
      if (v && v.to === null && (e.code === 'KeyA' || e.code === 'KeyD') && v.links.length) {
        s.ventSel = (s.ventSel + (e.code === 'KeyD' ? 1 : v.links.length - 1)) % v.links.length;
        sfx.click2();
        return;
      }
      if (v && v.to === null && e.code === 'KeyW' && v.links.length) this.socket.emit('vent:select', { to: v.links[s.ventSel % v.links.length] });
    }
    switch (e.code) {
      case 'KeyF':
        if (s.alive) {
          this.socket.emit('interact', {}, (res) => {
            if (res && res.type === 'switch') this.onToast(res.on ? 'Lights on' : 'Lights off');
          });
        }
        return;
      // Items: E = slot 1, R = slot 2 (the number keys are for typing codes)
      case 'KeyE':
      case 'KeyR':
        e.preventDefault();
        if (s.alive) {
          const slot = e.code === 'KeyE' ? 0 : 1;
          if (this.snap?.me.inv?.[slot]) {
            this.socket.emit('item:use', { slot });
            this.hud.flashSlot(slot);
          } else this.onToast('That slot is empty');
        }
        return;
      case 'KeyQ':
        if (s.alive) {
          const inv = this.snap?.me.inv || [];
          const filled = inv.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
          if (filled.length === 1) this.socket.emit('item:drop', { slot: filled[0] });
          else if (filled.length === 2) {
            s.dropMode = !s.dropMode;
            clearTimeout(this.dropTimer);
            this.dropTimer = setTimeout(() => { s.dropMode = false; }, 3000);
          } else this.onToast('Nothing to drop');
        }
        return;
      case 'KeyT':
      case 'Enter':
        e.preventDefault();
        this.openChat();
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!s.alive && !this.deathUntil) this.cycleSpectate(e.code === 'ArrowRight' ? 1 : -1);
        e.preventDefault();
        return;
      case 'ArrowDown':
      case 'ArrowUp':
        if (!s.alive && !this.deathUntil) {
          if (e.code === 'ArrowDown') this.spectateId = null; // free camera
          else if (!this.spectateId) this.cycleSpectate(1);
        }
        e.preventDefault();
        return;
      case 'Space':
        e.preventDefault();
        break;
      default:
        break;
    }
    this.keys.add(e.code);
  }

  onMouseMove(e) {
    if (document.pointerLockElement !== this.canvas) return;
    const sens = 0.0024;
    const s = this.self;
    if (s.alive && (s.locker !== null || s.vent)) {
      s.lockerLook = THREE.MathUtils.clamp(s.lockerLook - e.movementX * sens, s.vent ? -1.2 : -0.8, s.vent ? 1.2 : 0.8);
      s.pitch = THREE.MathUtils.clamp(s.pitch + e.movementY * sens, -0.5, 0.5);
      return;
    }
    s.viewYaw -= e.movementX * sens;
    s.pitch = THREE.MathUtils.clamp(s.pitch + e.movementY * sens, -1.45, 1.45);
  }

  isLiving(id) {
    const f = id ? this.flags.get(id) : null;
    return !!(f && !f.g && this.chars.has(id));
  }

  livingIds() {
    const out = [];
    for (const id of this.chars.keys()) if (this.isLiving(id)) out.push(id);
    return out;
  }

  nearestLiving(x, z, except = null) {
    let best = null;
    let bd = Infinity;
    for (const id of this.livingIds()) {
      if (id === except) continue;
      const p = this.chars.get(id).root.position;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  cycleSpectate(dir) {
    const living = this.livingIds();
    if (!living.length) {
      this.spectateId = null;
      return;
    }
    const i = living.indexOf(this.spectateId);
    this.spectateId = living[(i + dir + living.length) % living.length];
    sfx.click2();
  }

  /** Feed entry: if the player we're watching (or about to watch) died, follow their killer. */
  onSomeoneDied(f) {
    if (this.self.alive || !f.victimId) return;
    const watching = this.deathUntil ? this.pendingSpectate : this.spectateId;
    if (watching !== f.victimId) return;
    const ch = this.chars.get(f.victimId);
    const pos = ch ? ch.root.position : this.self;
    const next = f.killerId && f.killerId !== this.selfId && this.isLiving(f.killerId) ? f.killerId : this.nearestLiving(pos.x, pos.z, f.victimId);
    if (this.deathUntil) this.pendingSpectate = next || 'nearest';
    else this.spectateId = next;
    if (!this.deathUntil && next) this.onToast(`${f.victim} died — now watching ${this.roster.get(next)?.name || 'their killer'}`);
  }

  // ------------------------------------------------------------------ net
  onKillResult(res) {
    if (!res) return;
    this.killbox.result(res);
    if (res.ok) {
      sfx.kill();
      this.hud.announce(`ELIMINATED ${res.victim}`, '', res.victimColor || '#ff3860', 2000);
    }
  }

  onDied(d) {
    if (!this.self.alive) return;
    this.killbox.reset();
    this.killbox.setVisible(false);
    sfx.death();
    this.self.alive = false;
    this.self.locker = null;
    this.self.vent = null;
    this.self.watching = false;
    this.self.y = floorHeight(this.map, this.self.x, this.self.z, this.self.level) + EYE;
    this.selfChar.setGhost(true);
    document.body.classList.add('ghost');
    document.body.classList.remove('watching');
    this.hud.setSecurity(false);
    this.hud.setVent(false);
    // 3 s death screen, then watch the killer through their eyes (zone/other deaths: nearest living player)
    this.hud.showDeath({ cause: d.cause, by: d.by, color: d.byColor, survivedMs: d.survivedMs });
    this.deathUntil = performance.now() + DEATH_SCREEN_MS;
    this.deathPos = { x: this.self.x, z: this.self.z };
    this.pendingSpectate = d.cause === 'kill' && d.byId ? d.byId : 'nearest';
    this.spectateId = null;
    this.hud.vignette.classList.add('hit');
    setTimeout(() => this.hud.vignette.classList.remove('hit'), 400);
  }

  /** After the death screen: start spectating (killer if alive, else the nearest living player). */
  finishDeathScreen() {
    this.deathUntil = 0;
    this.hud.hideDeath();
    const want = this.pendingSpectate;
    this.pendingSpectate = null;
    const pos = this.deathPos || this.self;
    this.spectateId = want && want !== 'nearest' && this.isLiving(want) ? want : this.nearestLiving(pos.x, pos.z);
  }

  serverNow() {
    return performance.now() + (this.timeOffset ?? 0);
  }

  onSnap(snap) {
    const sample = snap.t - performance.now();
    if (this.timeOffset === null || Math.abs(sample - this.timeOffset) > 1000) this.timeOffset = sample;
    else this.timeOffset += (sample - this.timeOffset) * 0.05;
    // Rarely-changing state is only sent when it changes
    if (snap.doors !== undefined) this.doorState = snap.doors;
    if (snap.lights !== undefined) this.lightState = snap.lights;
    if (snap.pk !== undefined) this.pickups = snap.pk;
    this.snap = snap;

    const seen = new Set();
    const bountyId = snap.bounty?.id;
    for (const p of snap.ps) {
      if (p.id === this.selfId) {
        this.selfFlags = p;
        continue;
      }
      seen.add(p.id);
      let ch = this.chars.get(p.id);
      if (!ch && this.parked.has(p.id)) {
        // Reuse the character we already built for this player (e.g. they reappear as a ghost)
        ch = this.parked.get(p.id);
        this.parked.delete(p.id);
        ch.root.visible = true;
        ch.root.position.set(p.x, p.y ?? (p.lv ?? 0) * H, p.z);
        this.chars.set(p.id, ch);
        this.buffers.set(p.id, []);
        this.stepTimers.set(p.id, Math.random() * STEP_INTERVAL);
      }
      if (!ch) {
        const info = this.roster.get(p.id) || { id: p.id, name: '???', color: '#888' };
        ch = new Character(info);
        ch.root.position.set(p.x, p.y ?? (p.lv ?? 0) * H, p.z);
        this.scene.add(ch.root);
        this.uploadTextures(ch.root); // labels go to the GPU now, not the first time they come into view
        this.chars.set(p.id, ch);
        this.buffers.set(p.id, []);
        this.stepTimers.set(p.id, Math.random() * STEP_INTERVAL);
      }
      ch.setGhost(!!p.g);
      const buf = this.buffers.get(p.id);
      const y = p.g ? p.y : floorHeight(this.map, p.x, p.z, p.lv ?? 0); // follows stair ramps
      const last = buf[buf.length - 1];
      if (last && Math.abs(last.y - y) > 1) buf.length = 0; // level change: don't interpolate through floors
      buf.push({ t: snap.t, x: p.x, y, z: p.z, yaw: p.yaw });
      if (buf.length > 30) buf.shift();
      p.bt = p.id === bountyId;
      this.flags.set(p.id, p);
      ch.setCode(snap.codes[p.id] || null, !!p.kb);
    }
    for (const [id, ch] of this.chars) {
      if (!seen.has(id)) {
        // Park it (hidden) instead of disposing: no GPU resources are rebuilt if the player shows up again
        ch.root.visible = false;
        this.parked.set(id, ch);
        this.chars.delete(id);
        this.buffers.delete(id);
        this.flags.delete(id);
        if (this.spectateId === id) this.spectateId = null;
      }
    }

    const me = snap.me;
    const s = this.self;
    if (me.alive) {
      // Our level is predicted locally while walking stairs; the server sends a 'correct' if we disagree.
      if (me.lv !== undefined && me.lv !== s.level && (s.vent || me.vent || !this.nearStairs(s.x, s.z))) s.level = me.lv;
      const lk = me.lk;
      if (lk !== s.locker) {
        s.locker = lk;
        s.lockerLook = 0;
        if (lk !== null) {
          s.pitch = 0;
          sfx.close();
        } else {
          sfx.open();
          s.pitch = 0.05;
        }
      }
      const wasVent = !!s.vent;
      s.vent = me.vent;
      if (s.vent && !wasVent) {
        s.ventSel = 0;
        s.lockerLook = 0;
        s.pitch = 0;
      }
      if (s.vent && this.selfFlags) {
        s.x = this.selfFlags.x;
        s.z = this.selfFlags.z;
      }
      if (!s.vent && wasVent) s.pitch = 0.05;
      const watching = !!me.watch;
      if (watching !== s.watching) {
        s.watching = watching;
        document.body.classList.toggle('watching', watching);
        this.secFresh = true;
        this.hud.setSecurity(watching, this.map.security?.cameras || []);
        if (watching) this.killbox.reset();
      }
    }
    this.world.setDoors(this.doorState);
    this.world.setLights(this.lightState);
    this.world.setLightsOut(snap.lo ? snap.lo.phase : null);
    this.world.setZone(snap.zone);
    this.world.setPickups(this.pickups);
    this.hud.update(snap, s);
  }

  nearStairs(x, z) {
    for (const st of this.map.stairs) if (pointInBox(x, z, st, 1.2)) return true;
    return false;
  }

  // ------------------------------------------------------------------ effects
  deathFx({ id, x, z, level, color }, warm = false) {
    const y0 = (level ?? 0) * H;
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
    const parts = [];
    for (let i = 0; i < 34; i++) {
      const m = new THREE.Mesh(FX_GEO.shard, mat);
      m.position.set(x, y0 + 0.6 + Math.random() * 1.2, z);
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 5;
      parts.push({ m, v: new THREE.Vector3(Math.cos(a) * sp, 3 + Math.random() * 5, Math.sin(a) * sp), r: new THREE.Vector3(Math.random() * 10, Math.random() * 10, 0) });
      g.add(m);
    }
    const ring = new THREE.Mesh(FX_GEO.ring, new THREE.MeshBasicMaterial({ color: 0xff2050, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y0 + 0.05, z);
    g.add(ring);
    const pillar = new THREE.Mesh(FX_GEO.pillar, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    pillar.position.set(x, y0 + 10, z);
    g.add(pillar);
    this.scene.add(g);
    const fx = {
      dur: 1.8, t: warm ? 1.8 : 0, g,
      tick: (e, dt, k) => {
        for (const p of parts) {
          p.v.y -= 14 * dt;
          p.m.position.addScaledVector(p.v, dt);
          if (p.m.position.y < y0 + 0.07) {
            p.m.position.y = y0 + 0.07;
            p.v.multiplyScalar(0.5);
            p.v.y = Math.abs(p.v.y) * 0.3;
          }
          p.m.rotation.x += p.r.x * dt;
          p.m.rotation.y += p.r.y * dt;
        }
        mat.opacity = 1 - k;
        ring.scale.setScalar(1 + k * 14);
        ring.material.opacity = 1 - k;
        pillar.material.opacity = 0.6 * (1 - k);
        pillar.scale.x = pillar.scale.z = 1 - k * 0.9;
      },
    };
    this.effects.push(fx);
    if (warm) return;
    const d = dist2D(this.self.x, this.self.z, x, z);
    if (id !== this.selfId) {
      if (d < 15) this.shake = Math.max(this.shake, 0.4 * (1 - d / 15));
      sfx.distantDeath();
    }
    const ch = this.chars.get(id);
    if (ch && this.self.alive) ch.root.visible = false;
  }

  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      const k = Math.min(1, e.t / e.dur);
      e.tick(e, dt, k);
      if (k >= 1) {
        this.scene.remove(e.g);
        e.g.traverse((o) => {
          if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
          if (o.material && !o.material.map) o.material.dispose();
        });
        this.effects.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------------ simulation
  inputVector() {
    const k = this.keys;
    let f = 0;
    let r = 0;
    if (k.has('KeyW')) f += 1;
    if (k.has('KeyS')) f -= 1;
    if (k.has('KeyD')) r += 1;
    if (k.has('KeyA')) r -= 1;
    return { f, r };
  }

  stepSelf(dt) {
    const s = this.self;
    if (s.alive && s.locker === null) s.yaw = s.viewYaw + Math.PI; // your body faces where you look
    const { f, r } = this.chatOpen ? { f: 0, r: 0 } : this.inputVector();
    const yaw = s.viewYaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    if (!s.alive) {
      if (this.spectateId) return;
      const up = (this.keys.has('Space') ? 1 : 0) - (this.keys.has('KeyC') || this.keys.has('ControlLeft') ? 1 : 0);
      const cp = Math.cos(s.pitch);
      const dx = fx * cp * f + rx * r;
      const dy = -Math.sin(s.pitch) * f + up;
      const dz = fz * cp * f + rz * r;
      const len = Math.hypot(dx, dy, dz);
      if (len > 0) {
        const sp = (GHOST_SPEED * 0.95 * dt) / len;
        s.x += dx * sp;
        s.y = THREE.MathUtils.clamp(s.y + dy * sp, -H, 35);
        s.z += dz * sp;
        const lim = this.map.size / 2 + 4;
        s.x = THREE.MathUtils.clamp(s.x, -lim, lim);
        s.z = THREE.MathUtils.clamp(s.z, -lim, lim);
      }
      return;
    }
    if (s.locker !== null || s.vent || s.watching) {
      s.moving = false;
      s.ventInput = s.vent ? (this.keys.has('KeyW') ? 1 : this.keys.has('KeyS') ? -1 : 0) : 0;
      return;
    }
    s.crouch = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    let dx = fx * f + rx * r;
    let dz = fz * f + rz * r;
    const len = Math.hypot(dx, dz);
    s.moving = len > 0;
    if (len > 0) {
      const speed = WALK_SPEED * (s.crouch ? CROUCH_MULT : 1) * (this.killbox.isOpen ? KILLBOX_MULT : 1);
      dx = (dx / len) * speed * dt;
      dz = (dz / len) * speed * dt;
      // Doors near you open by themselves (the server does the same), so predict them as open
      const geo = levelGeo(this.map, s.level, predictedDoorState(this.map, this.doorState, s.x, s.z, s.level));
      const p = moveWithCollisions(geo, s.x, s.z, dx, dz, PLAYER_RADIUS);
      s.x = p.x;
      s.z = p.z;
      s.level = resolveStairs(this.map, s.x, s.z, s.level); // walking up / down a ramp changes floor
      if (!s.crouch) {
        s.stepT += dt * (this.killbox.isOpen ? 0.4 : 1);
        if (s.stepT > STEP_INTERVAL) {
          s.stepT = 0;
          ownStep();
        }
      }
    }
  }

  sendInput(now) {
    if (now - this.lastSend < TICK_MS) return;
    this.lastSend = now;
    const s = this.self;
    if (s.alive) {
      this.socket.emit('move', {
        x: +s.x.toFixed(3), z: +s.z.toFixed(3), yaw: +s.yaw.toFixed(3), cr: s.crouch ? 1 : 0, lv: s.level,
        vy: +this.lookYaw().toFixed(3), vp: +s.pitch.toFixed(2), vf: s.vent ? s.ventInput || 0 : 0,
      });
    } else if (!this.spectateId && !this.deathUntil) this.socket.emit('move', { x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3), yaw: 0 });
  }

  /** Camera "view yaw" convention (forward = -sin, -cos) for whatever the player is looking through. */
  lookYaw() {
    const s = this.self;
    if (s.locker !== null) {
      const l = this.map.lockers[s.locker];
      if (l) return l.yaw + s.lockerLook + Math.PI;
    }
    return s.viewYaw;
  }

  interpolate(dt) {
    const rt = this.serverNow() - INTERP_DELAY;
    const s = this.self;
    for (const [id, ch] of this.chars) {
      const buf = this.buffers.get(id);
      if (!buf || !buf.length) continue;
      let a = buf[0];
      let b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= rt && buf[i + 1].t >= rt) {
          a = buf[i];
          b = buf[i + 1];
          break;
        }
      }
      let x;
      let y;
      let z;
      let yaw;
      if (rt >= b.t || a === b) ({ x, y, z, yaw } = b);
      else {
        const k = (rt - a.t) / Math.max(1, b.t - a.t);
        x = a.x + (b.x - a.x) * k;
        y = a.y + (b.y - a.y) * k;
        z = a.z + (b.z - a.z) * k;
        const dy = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
        yaw = a.yaw + dy * k;
      }
      ch.root.position.set(x, y, z);
      ch.root.rotation.y = yaw;
      const cd2 = (x - this.camera.position.x) ** 2 + (z - this.camera.position.z) ** 2;
      const cull = s.watching ? 1e6 : this.cullDist;
      ch.setLod(cd2 > cull * cull, cd2 < 22 * 22 || s.watching);
      const f = this.flags.get(id) || {};
      const lv = f.lv ?? 0;
      const cutAway = false;
      ch.update(dt, {
        moving: !!f.mv, crouch: !!f.cr || !!f.vt, hood: !!f.h, shimmer: !!f.s, revealed: !!f.rv,
        hidden: !!f.lk || !!f.vt || cutAway, bounty: !!f.bt, flashlight: !!f.fl, flashYaw: f.fy, seated: !!f.wt,
      }, this.camera);
      if (f.vt && f.mv) {
        let t = this.stepTimers.get(id) + dt;
        if (t > 0.5) {
          t = 0;
          if (dist2D(x, z, s.x, s.z) < 14) clank(x, lv * H + VENT_DEPTH, z);
        }
        this.stepTimers.set(id, t);
      } else if (f.mv && !f.cr && !f.g && !f.lk) {
        let t = this.stepTimers.get(id) + dt * (f.kb ? 0.4 : 1);
        if (t > STEP_INTERVAL) {
          t = 0;
          footstep(x, z, lv !== s.level ? 0.25 : 0.6);
        }
        this.stepTimers.set(id, t);
      }
    }
  }

  updateCamera(dt) {
    const s = this.self;
    const cam = this.camera;
    if (this.debugCam) {
      const d = this.debugCam;
      cam.position.set(...d.pos);
      cam.lookAt(...d.look);
      return;
    }
    // Floor under you (follows stair ramps), so the eye never clips through a ceiling
    const baseY = floorHeight(this.map, s.x, s.z, s.level);
    if (s.alive && s.vent) {
      // First-person crawl inside the duct
      const v = this.snap?.me.vent;
      const vents = this.map.vents;
      let dir = 0;
      let ventLevel = s.level;
      if (v && vents[v.at]) {
        const toId = v.to !== null ? v.to : v.links[s.ventSel % Math.max(1, v.links.length)];
        const from = vents[v.at];
        const to = toId !== undefined ? vents[toId] : null;
        ventLevel = from.level;
        if (to) dir = Math.atan2(to.x - from.x, to.z - from.z);
      }
      cam.position.set(s.x, ventLevel * H + VENT_DEPTH, s.z);
      const a = dir + s.lockerLook;
      tmpV.set(cam.position.x + Math.sin(a), cam.position.y - Math.sin(s.pitch) * 0.6, cam.position.z + Math.cos(a));
      cam.lookAt(tmpV);
      return;
    }
    if (s.alive && s.locker !== null) {
      const l = this.map.lockers[s.locker];
      const a = l.yaw + s.lockerLook;
      cam.position.set(l.x + l.fx * 0.2, baseY + 1.6, l.z + l.fz * 0.2);
      tmpV.set(cam.position.x + Math.sin(a), baseY + 1.6 - Math.sin(s.pitch), cam.position.z + Math.cos(a));
      cam.lookAt(tmpV);
      this.selfChar.root.visible = false;
      return;
    }
    // Death screen: the camera slowly lifts off your body
    if (!s.alive && this.deathUntil) {
      cam.position.y += dt * 0.35;
      return;
    }
    // Ghosts spectating a living player see through their eyes
    if (!s.alive && this.spectateId && this.chars.has(this.spectateId)) {
      const ch = this.chars.get(this.spectateId);
      const p = ch.root.position;
      const f = this.flags.get(this.spectateId) || {};
      cam.position.set(p.x, p.y + (f.cr ? CROUCH_EYE : EYE), p.z);
      const a = ch.root.rotation.y;
      tmpV.set(p.x + Math.sin(a), cam.position.y - 0.05, p.z + Math.cos(a));
      cam.lookAt(tmpV);
      ch.root.visible = false;
      return;
    }
    if (!s.alive) {
      cam.position.set(s.x, s.y, s.z);
      const cp = Math.cos(s.pitch);
      tmpV.set(s.x - Math.sin(s.viewYaw) * cp, s.y - Math.sin(s.pitch), s.z - Math.cos(s.viewYaw) * cp);
      cam.lookAt(tmpV);
      return;
    }
    // First person: eye height eases when crouching, slight head bob while walking
    const targetEye = s.crouch ? CROUCH_EYE : EYE;
    this.eyeY += (targetEye - this.eyeY) * Math.min(1, dt * 10);
    if (s.moving) this.headBob += dt * (s.crouch ? 7 : 10);
    const bob = s.moving ? Math.sin(this.headBob) * 0.035 : 0;
    const cp = Math.cos(s.pitch);
    const fwdX = -Math.sin(s.viewYaw) * cp;
    const fwdY = -Math.sin(s.pitch);
    const fwdZ = -Math.cos(s.viewYaw) * cp;
    const eye = vEye.set(s.x + fwdX * 0.12, baseY + this.eyeY + bob, s.z + fwdZ * 0.12);
    // Intro: start behind and above in third person, then glide into your eyes
    const t = (performance.now() - this.introStart) / INTRO_MS;
    if (t < 1) {
      const hold = Math.min(1, Math.max(0, (t - 0.35) / 0.65));
      const k = hold * hold * (3 - 2 * hold);
      const back = vBack.set(s.x + Math.sin(s.viewYaw) * 5.5, baseY + 3.6, s.z + Math.cos(s.viewYaw) * 5.5);
      cam.position.copy(back).lerp(eye, k);
      const lookTarget = vLook.set(s.x, baseY + 1.4, s.z).lerp(vLook2.set(eye.x + fwdX, eye.y + fwdY, eye.z + fwdZ), k);
      cam.lookAt(lookTarget);
      this.selfVisible = k < 0.85;
    } else {
      cam.position.copy(eye);
      cam.lookAt(eye.x + fwdX, eye.y + fwdY, eye.z + fwdZ);
      this.selfVisible = false;
    }
    if (this.shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this.shake;
      cam.position.y += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 1.5);
    }
  }

  updateHint() {
    const s = this.self;
    const hud = this.hud;
    const base = 'WASD move · <kbd>Shift</kbd> crouch · <b>type 4 digits</b> to strike · <kbd>F</kbd> use · <kbd>E</kbd><kbd>R</kbd> items · <kbd>Q</kbd> drop · <kbd>T</kbd> chat';
    if (!s.alive) {
      hud.spectate.classList.toggle('on', !this.deathUntil);
      const info = this.spectateId ? this.roster.get(this.spectateId) : null;
      const html = info
        ? `SPECTATING <b style="color:${info.color}">${escapeHtml(info.name)}</b><small>←/→ or click: switch player · ↓ free camera · T ghost chat</small>`
        : 'FREE CAMERA<small>WASD fly · Space/C up/down · ←/→ or click: spectate a player · T ghost chat</small>';
      if (hud.spectate.innerHTML !== html) hud.spectate.innerHTML = html;
      hud.setHint('');
      hud.setVent(false);
      return;
    }
    hud.spectate.classList.remove('on');
    if (s.vent) {
      const v = this.snap?.me.vent;
      let html;
      if (!v || v.to === null) {
        const opts = v ? v.links : [];
        const sel = opts.length ? opts[s.ventSel % opts.length] : null;
        html = opts.length
          ? `<b>IN THE VENTS</b> — <kbd>A</kbd>/<kbd>D</kbd> pick a duct (→ vent ${sel + 1} of ${this.map.vents.length}) · hold <kbd>W</kbd> to crawl · <kbd>F</kbd> climb out`
          : '<b>IN THE VENTS</b> — <kbd>F</kbd> climb out';
      } else html = `<b>CRAWLING</b> ${Math.round(v.t * 100)}% — hold <kbd>W</kbd> forward / <kbd>S</kbd> back · others can hear the clanking`;
      hud.setVent(true, html);
      hud.setHint('');
      return;
    }
    hud.setVent(false);
    if (s.watching) {
      hud.setHint('');
      return;
    }
    if (s.locker !== null) {
      hud.setHint('<span class="act">HIDING — CODE INVISIBLE</span><kbd>F</kbd> leave · Mouse to peek · type 4 digits to strike');
      return;
    }
    const it = findInteractable(this.map, s.x, s.z, s.level, {});
    let act = '';
    if (it) {
      switch (it.type) {
        case 'switch': act = `<span class="act"><kbd>F</kbd> LIGHT ${this.lightState[it.obj.roomId] === '0' ? 'ON' : 'OFF'}</span>`; break;
        case 'locker': act = `<span class="act"><kbd>F</kbd> HIDE IN ${it.obj.kind === 'wardrobe' ? 'WARDROBE' : 'LOCKER'}</span>`; break;
        case 'vent': act = '<span class="act"><kbd>F</kbd> CRAWL INTO VENT</span>'; break;
        case 'monitor': act = '<span class="act"><kbd>F</kbd> WATCH SECURITY CAMERAS</span>'; break;
        default: break;
      }
    }
    {
      // Sealed doors (red light) only open with a Master Key — and then stay open
      const d = nearestDoor(this.map, s.x, s.z, s.level, 2.2);
      if (d && this.doorState[d.id] === '2') {
        const inv = this.snap?.me.inv || [];
        const slot = inv.indexOf('masterkey');
        act += slot >= 0
          ? `<span class="act"><kbd>${slot === 0 ? 'E' : 'R'}</kbd> USE MASTER KEY</span>`
          : '<span class="act red">🔒 SEALED DOOR — needs a Master Key</span>';
      }
    }
    hud.setHint(`${act}${base}`);
  }

  flashlightList() {
    const out = [];
    const s = this.self;
    if (s.alive && this.snap?.me.flash) {
      const a = this.lookYaw();
      out.push({ x: s.x, y: floorHeight(this.map, s.x, s.z, s.level) + 1.45, z: s.z, dirX: -Math.sin(a), dirZ: -Math.cos(a), dirY: -Math.sin(s.pitch) * 0.8, d: 0 });
    }
    for (const [id, ch] of this.chars) {
      const f = this.flags.get(id);
      if (!f || !f.fl || !ch.root.visible) continue;
      const p = ch.root.position;
      out.push({ x: p.x, y: p.y + 1.4, z: p.z, dirX: Math.sin(f.fy), dirZ: Math.cos(f.fy), d: (p.x - s.x) ** 2 + (p.z - s.z) ** 2 });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /**
   * Security monitors: each camera renders into a small offscreen target (two cameras per frame,
   * round-robin, so each feed updates at ~30 fps), then one cheap pass draws the 4 feeds.
   * Mirrors and shadow refreshes are paused while watching (see loop / updateReflectors).
   */
  setupSecurityView() {
    this.secTargets = this.secCams.map(() => new THREE.WebGLRenderTarget(640, 360));
    this.secScene = new THREE.Scene();
    this.secOrtho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 4; i++) {
      const rt = this.secTargets[i];
      const m = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ map: rt ? rt.texture : null, color: rt ? 0xffffff : 0x050508, depthTest: false, depthWrite: false }));
      m.position.set(i % 2 ? 0.5 : -0.5, i < 2 ? 0.5 : -0.5, 0);
      this.secScene.add(m);
    }
    this.secTurn = 0;
    this.secFresh = true;
  }

  renderSecurity() {
    const r = this.renderer;
    const n = this.secCams.length;
    // First frame of watching: all feeds. Then 2 per frame, alternating.
    const count = this.secFresh ? n : Math.min(2, n);
    this.secFresh = false;
    for (let k = 0; k < count; k++) {
      const i = (this.secTurn + k) % n;
      const cam = this.secCams[i];
      cam.aspect = 16 / 9;
      cam.updateProjectionMatrix();
      r.setRenderTarget(this.secTargets[i]);
      r.render(this.scene, cam);
    }
    this.secTurn = (this.secTurn + count) % Math.max(1, n);
    r.setRenderTarget(null);
    r.render(this.secScene, this.secOrtho);
  }

  loop(now) {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const work0 = performance.now();
    const frameMs = now - this.lastFrame;
    const dt = Math.min(0.05, frameMs / 1000);
    this.lastFrame = now;
    const t = now / 1000;
    const s = this.self;
    if (this.deathUntil && performance.now() >= this.deathUntil) this.finishDeathScreen();
    // The player we watch died without a feed entry reaching us: pick someone else
    if (!s.alive && !this.deathUntil && this.spectateId && !this.isLiving(this.spectateId)) {
      const ch = this.chars.get(this.spectateId);
      this.spectateId = ch ? this.nearestLiving(ch.root.position.x, ch.root.position.z, this.spectateId) : this.nearestLiving(s.x, s.z);
    }

    this.stepSelf(dt);
    this.sendInput(now);
    this.interpolate(dt);

    // Self character
    const sc = this.selfChar;
    const floorY = s.alive ? floorHeight(this.map, s.x, s.z, s.level) : s.y - 1.6;
    sc.root.position.set(s.x, floorY, s.z);
    sc.root.rotation.y = s.yaw;
    sc.root.visible = true;
    const sf = this.selfFlags || {};
    const bountyMe = this.snap?.bounty?.id === this.selfId;
    const lookDir = this.lookYaw();
    sc.update(dt, {
      moving: s.moving, crouch: s.crouch, hood: !!sf.h && s.alive, shimmer: !!sf.s && s.alive, revealed: !!sf.rv && s.alive,
      hidden: false, bounty: bountyMe && s.alive, flashlight: !!this.snap?.me.flash && s.alive,
      flashYaw: Math.atan2(-Math.sin(lookDir), -Math.cos(lookDir)), seated: s.watching,
    }, this.camera);
    this.selfVisible = false;
    this.updateCamera(dt);
    sc.root.visible = this.selfVisible && s.alive && !s.vent && s.locker === null;
    this.updateEffects(dt);
    this.world.ductGroup.visible = !!(s.alive && s.vent);

    // Darkness: lights out, dark rooms, basements
    const snap = this.snap;
    const lo = snap?.lo;
    const inDark = s.alive && isDarkSpot(this.map, s.x, s.z, s.level, this.lightState);
    let darkTarget = lo && lo.phase === 'on' ? 1 : inDark ? (s.level < 0 ? 0.9 : 0.75) : 0;
    if (lo && lo.phase === 'warn') darkTarget = Math.random() < 0.3 ? 0.8 : 0;
    if (s.alive && s.vent) darkTarget = 0.6;
    this.world.setDarkness(this.debugCam ? 0 : darkTarget, dt);
    this.scene.fog.density = this.debugCam?.fog ?? this.fogBase + this.world.darkness * 0.07;
    if (s.alive && s.vent) {
      this.selfLight.intensity = 4;
      this.selfLight.position.copy(this.camera.position);
    } else {
      this.selfLight.intensity = this.world.darkness * 5;
      this.selfLight.position.set(s.x, floorY + 2.2, s.z);
    }
    if (now - this.lastLightUpdate > 120) {
      this.lastLightUpdate = now;
      this.world.cull(this.camera.position, s.watching ? 200 : this.cullDist);
      this.world.updateLights(this.camera.position, t, this.flashlightList());
      this.camera.getWorldDirection(vDir);
      // While on the security monitors the mirror/puddle reflectors are switched off entirely
      this.world.updateReflectors(this.camera.position, s.alive ? s.level : 0, vDir, s.alive && s.watching);
    }
    this.world.update(dt, t, this.camera.position, s.alive ? s.level : 0);

    // The code bar is on screen whenever you can strike
    this.killbox.setVisible(s.alive && !s.vent && !s.watching && !this.deathUntil);
    this.killbox.update(snap ? snap.me.lockMs : 0);
    this.hud.click.classList.toggle('on', document.pointerLockElement !== this.canvas && !this.chatOpen && !this.rewardOpen);
    this.updateHint();
    this.hud.updateMyCode();
    if (snap) {
      this.mmExtras ||= {};
      this.mmExtras.doors = this.doorState;
      this.mmExtras.pickups = this.pickups;
      this.mmExtras.spectateId = this.spectateId;
      this.hud.drawMinimap(this.map, snap, s, this.chars, this.mmExtras);
    }

    this.camera.getWorldDirection(vDir);
    setListener(this.camera.position, vDir);
    this.frameNo++;
    const every = this.quality.shadowEvery;
    if (every > 0 && !(s.alive && s.watching) && (this.frameNo % every === 0 || this.frameNo < 3)) this.renderer.shadowMap.needsUpdate = true;
    if (s.alive && s.watching && this.secCams.length) this.renderSecurity();
    else this.renderer.render(this.scene, this.camera);
    this.checkSpike(now, frameMs, performance.now() - work0);
    this.fpsFrames++;
    if (now - this.fpsAt > 500 && this.fpsEl) {
      const fps = (this.fpsFrames * 1000) / (now - this.fpsAt);
      this.fpsEl.textContent = `${fps.toFixed(0)} FPS · ${this.quality.label}`;
      this.fpsEl.classList.toggle('bad', fps < 30);
      this.fpsFrames = 0;
      this.fpsAt = now;
    }
  }

  /**
   * Compile every shader and upload every texture before play, so nothing is compiled mid-game
   * (first flashlight, first death, first pickup, lights out, ghosts, mirrors, vents…).
   */
  async warmup() {
    const t0 = performance.now();
    const r = this.renderer;
    const s = this.self;
    const y = floorHeight(this.map, s.x, s.z, s.level);
    const extras = [];
    const info = { id: '__warm', name: 'warm-up', color: '#ff3860' };
    const looks = [
      { moving: true, hood: true, shimmer: true, revealed: true, bounty: true, flashlight: true, flashYaw: 0 },
      { crouch: true, hidden: false, seated: true },
    ];
    for (const look of looks) {
      const ch = new Character(info);
      ch.setCode('12??', true);
      ch.root.position.set(s.x + 2, y, s.z + 2);
      ch.update(0.016, look, this.camera);
      this.scene.add(ch.root);
      extras.push(ch);
    }
    const selfGhost = new Character(info, { isSelf: true });
    selfGhost.setGhost(true);
    selfGhost.root.position.set(s.x - 2, y, s.z - 2);
    this.scene.add(selfGhost.root);
    extras.push(selfGhost);
    const ghost = new Character(info);
    ghost.setGhost(true);
    ghost.root.position.set(s.x - 2, y, s.z + 2);
    this.scene.add(ghost.root);
    extras.push(ghost);
    // One of every pickup, and a death effect
    const fakes = ITEM_IDS.map((item, i) => ({ id: `__w${i}`, type: 'item', item, x: s.x, z: s.z + 1 + i, level: s.level }));
    fakes.push({ id: '__wh', type: 'hood', x: s.x + 1, z: s.z, level: s.level });
    this.world.setPickups(fakes);
    this.deathFx({ id: '__warm', x: s.x, z: s.z + 3, level: s.level, color: '#ff3860' }, true);
    // Everything visible (ducts, reflectors, far lamps, lights-out lamps), all spot lights on
    const hidden = [];
    const culled = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
      // Draw everything once (frustum culling off) so every vertex buffer is uploaded at load time
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
    });
    this.world.setLightsOut('on');
    this.onResize();
    this.updateCamera(0);
    // Parallel shader compilation (KHR_parallel_shader_compile) keeps the page responsive meanwhile
    const tc = performance.now();
    if (r.compileAsync) {
      await r.compileAsync(this.scene, this.camera);
      // Mirrors/puddles render the scene into their own (linear) targets: those are different program variants
      for (const refl of [this.world.mirrorReflector, this.world.puddleReflector]) {
        const target = refl?.getRenderTarget?.();
        if (!target || !this.running) continue;
        r.setRenderTarget(target);
        await r.compileAsync(this.scene, this.camera);
        r.setRenderTarget(null);
      }
    } else r.compile(this.scene, this.camera);
    if (r.compileAsync) await r.compileAsync(this.secScene, this.secOrtho);
    const compileMs = performance.now() - tc;
    if (!this.running) return;
    const tb = performance.now();
    // Upload all textures now (canvas textures are generated at load, never during play)
    const seen = new Set();
    this.scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'alphaMap']) {
          const tex = m[k];
          if (tex && !seen.has(tex)) {
            seen.add(tex);
            r.initTexture?.(tex);
          }
        }
      }
    });
    const tTex = performance.now() - tb;
    // One real render (to the canvas, so the same tone-mapped programs are used; it also builds the
    // shadow-depth programs and the mirror/puddle reflector passes). The next frame overdraws it.
    const p0 = r.info.programs.length;
    r.shadowMap.needsUpdate = true;
    const t1 = performance.now();
    r.render(this.scene, this.camera);
    // one pass of the security feeds (targets + the 4-quad pass)
    this.secFresh = true;
    this.renderSecurity();
    const tR1 = performance.now() - t1;
    const p1 = r.info.programs.length;
    this.world.setLightsOut(null);
    const t2 = performance.now();
    r.render(this.scene, this.camera);
    console.info(`[ck] warm-up parts: textures ${Math.round(tTex)} ms, first render ${Math.round(tR1)} ms (+${p1 - p0} programs), second ${Math.round(performance.now() - t2)} ms`);
    for (const o of hidden) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
    for (const ch of extras) {
      this.scene.remove(ch.root);
      ch.dispose();
    }
    this.world.setPickups(this.pickups);
    this.updateEffects(0.016);
    this.lastPrograms = r.info.programs ? r.info.programs.length : 0;
    this.warmupMs = Math.round(performance.now() - t0);
    this.warmupBlockMs = Math.round(performance.now() - tb);
    console.info(`[ck] warm-up: ${this.lastPrograms} shader programs, ${seen.size} textures · compile ${Math.round(compileMs)} ms (async) + upload/first render ${this.warmupBlockMs} ms (blocking)`);
  }

  uploadTextures(root) {
    root.traverse((o) => {
      const m = o.material;
      if (m && !Array.isArray(m) && m.map) this.renderer.initTexture?.(m.map);
    });
  }

  initSpikeLogger() {
    this.spikeLog = [];
    this.evLog = [];
    this.lastPrograms = 0;
    this.lastSpikeSent = 0;
    this.lastHiddenAt = 0;
    this.longTasks = [];
    window.__ckSpikes = this.spikeLog;
    this.onVisibility = () => { this.lastHiddenAt = performance.now(); };
    document.addEventListener('visibilitychange', this.onVisibility);
    try {
      this.longObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longTasks.push({ t: e.startTime, ms: e.duration });
        if (this.longTasks.length > 60) this.longTasks.splice(0, 30);
      });
      this.longObs.observe({ entryTypes: ['longtask'] });
    } catch { /* long tasks not supported */ }
  }

  noteEvent(name) {
    this.evLog.push(performance.now(), name);
    if (this.evLog.length > 160) this.evLog.splice(0, 80);
  }

  /** Log any frame slower than 50 ms with what was going on (client side of the spike logger). */
  checkSpike(now, frameMs, workMs) {
    const r = this.renderer.info;
    const programs = r.programs ? r.programs.length : 0;
    const newPrograms = programs - this.lastPrograms;
    this.lastPrograms = programs;
    if (newPrograms > 0 && this.frameNo > 5) console.warn(`[ck] ${newPrograms} shader program(s) compiled during play (now ${programs})`);
    // Textures / geometries created during play (everything should be made at load time and reused)
    const tex = r.memory.textures;
    const geoN = r.memory.geometries;
    if (this.frameNo > 5 && this.lastTex !== undefined && (tex > this.lastTex || geoN > this.lastGeo + 4)) {
      const recent = [];
      for (let i = 0; i < this.evLog.length; i += 2) if (this.evLog[i] >= now - 300 && !recent.includes(this.evLog[i + 1])) recent.push(this.evLog[i + 1]);
      console.warn(`[ck] new GPU resources during play: textures ${this.lastTex}->${tex}, geometries ${this.lastGeo}->${geoN} (events: ${recent.join(',') || 'none'})`);
    }
    this.lastTex = tex;
    this.lastGeo = geoN;
    if (frameMs <= SPIKE_MS || this.frameNo < 20 || document.hidden || now - this.lastHiddenAt < 1500) return;
    const since = now - frameMs - 100;
    const events = [];
    for (let i = 0; i < this.evLog.length; i += 2) if (this.evLog[i] >= since && !events.includes(this.evLog[i + 1])) events.push(this.evLog[i + 1]);
    let longTask = 0;
    for (const lt of this.longTasks) if (lt.t >= since) longTask = Math.max(longTask, lt.ms);
    const s = this.self;
    let nearby = 0;
    for (const ch of this.chars.values()) if ((ch.root.position.x - s.x) ** 2 + (ch.root.position.z - s.z) ** 2 < 225) nearby++;
    const entry = {
      at: Math.round(now), frameMs: Math.round(frameMs), workMs: Math.round(workMs * 10) / 10,
      events: events.join(',') || 'none', programs, newPrograms, geometries: r.memory.geometries, textures: r.memory.textures,
      drawCalls: r.render.calls, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined,
      players: this.chars.size, nearby, longTask: Math.round(longTask),
      phase: `${s.alive ? 'alive' : 'ghost'}${this.snap?.lo?.phase ? `/lights-${this.snap.lo.phase}` : ''}${s.watching ? '/security' : ''}${s.vent ? '/vent' : ''}`,
    };
    this.spikeLog.push(entry);
    if (this.spikeLog.length > 300) this.spikeLog.shift();
    console.warn('[ck spike]', JSON.stringify(entry));
    if (now - this.lastSpikeSent > 600) {
      this.lastSpikeSent = now;
      this.socket.emit('perf:spike', entry);
    }
  }

  dispose() {
    this.running = false;
    setAmbient(false);
    this.longObs?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.hud.hideDeath();
    for (const [ev, fn] of Object.entries(this.net)) this.socket.off(ev, fn);
    window.removeEventListener('resize', this.handlers.resize);
    window.removeEventListener('keydown', this.handlers.keydown);
    window.removeEventListener('keyup', this.handlers.keyup);
    window.removeEventListener('mousemove', this.handlers.mousemove);
    window.removeEventListener('blur', this.handlers.blur);
    this.canvas.removeEventListener('click', this.handlers.click);
    this.hud.chatBox.querySelector('form').removeEventListener('submit', this.chatSubmit);
    this.hud.chatInput.removeEventListener('keydown', this.chatKey);
    this.killbox.reset();
    this.hud.reset();
    document.exitPointerLock?.();
    document.body.classList.remove('ghost', 'watching');
    for (const ch of this.chars.values()) ch.dispose();
    for (const ch of this.parked.values()) ch.dispose();
    for (const t of this.secTargets || []) t.dispose();
    this.selfChar.dispose();
    this.world.dispose();
    this.renderer.dispose();
  }
}
