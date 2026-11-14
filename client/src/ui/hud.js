import { ITEMS, RARITY_COLOR } from '@shared/items.js';
import { sfx } from '../audio.js';

const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmt(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Hud {
  constructor() {
    this.el = $('hud');
    this.alive = $('alive-count');
    this.zoneTimer = $('zone-timer');
    this.zoneLabel = $('zone-label');
    this.hpBar = $('hp-bar');
    this.hpText = $('hp-text');
    this.chips = $('status-chips');
    this.feed = $('feed');
    this.hint = $('hint');
    this.center = $('center-msg');
    this.grace = $('grace');
    this.vignette = $('vignette');
    this.slats = $('locker-slats');
    this.click = $('click-to-play');
    this.spectate = $('spectate-bar');
    this.minimap = $('minimap');
    this.mctx = this.minimap.getContext('2d');
    this.mycode = this.el.querySelector('.mycode');
    this.mycodeDigits = this.mycode.querySelector('.digits');
    this.chatBox = $('game-chat');
    this.chatLog = this.chatBox.querySelector('.chat-log');
    this.chatInput = this.chatBox.querySelector('input');
    this.inventory = $('inventory');
    this.slots = [...this.inventory.querySelectorAll('.slot')];
    this.weather = $('weather');
    this.death = $('death-screen');
    this.bountyBanner = $('bounty-banner');
    this.loWarn = $('lo-warn');
    this.glimpse = $('glimpse');
    this.vent = $('vent-overlay');
    this.security = $('security-overlay');
    this.reward = $('reward');
    this.levelPill = $('level-pill');
    this.lastGraceSec = -1;
    this.centerTimer = null;
    this.lastHp = 100;
    this.invKey = '';
    this.selfCodeUntil = 0;
    this.selfCode = null;
    this.glimpses = [];
    this.mapLayers = null;
    this.toastTimer = null;
    this.reward.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', () => this.onRewardChoice?.(b.dataset.choice)));
  }

  reset() {
    this.feed.innerHTML = '';
    this.chatLog.innerHTML = '';
    this.center.classList.remove('show');
    this.grace.classList.remove('show');
    this.vignette.className = 'vignette';
    this.slats.classList.remove('on');
    this.spectate.classList.remove('on');
    this.chatBox.classList.remove('open');
    this.chatInput.value = '';
    this.vent.classList.remove('on');
    this.security.classList.remove('on');
    this.reward.classList.remove('on');
    this.loWarn.classList.remove('on');
    this.bountyBanner.classList.remove('on');
    this.glimpse.classList.remove('on');
    this.hideDeath();
    this.lastGraceSec = -1;
    this.lastHp = 100;
    this.invKey = '';
    this.selfCodeUntil = 0;
    this.glimpses = [];
    this.mapLayers = null;
    this.mycodeDigits.textContent = '? ? ? ?';
    this.mycode.classList.remove('revealed');
  }

  announce(text, sub = '', color = '#ff3860', ms = 2600) {
    this.center.innerHTML = `${escapeHtml(text)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}`;
    this.center.style.color = color;
    this.center.style.textShadow = `0 0 12px ${color}, 0 0 40px ${color}`;
    this.center.classList.remove('show');
    void this.center.offsetWidth;
    this.center.classList.add('show');
    clearTimeout(this.centerTimer);
    this.centerTimer = setTimeout(() => this.center.classList.remove('show'), ms);
  }

  addFeed(f) {
    const div = document.createElement('div');
    div.className = `f ${f.cause}`;
    const nm = (n, c) => `<b style="color:${c}">${escapeHtml(n)}</b>`;
    if (f.cause === 'kill') div.innerHTML = `🔪 ${nm(f.killer, f.killerColor)} eliminated ${nm(f.victim, f.victimColor)}`;
    else if (f.cause === 'bounty') div.innerHTML = `💰 ${nm(f.killer, f.killerColor)} claimed the bounty on ${nm(f.victim, f.victimColor)}`;
    else if (f.cause === 'zone') div.innerHTML = `☠ ${nm(f.victim, f.victimColor)} was consumed by the zone`;
    else if (f.cause === 'guesses') div.innerHTML = `✖ ${nm(f.victim, f.victimColor)} guessed wrong once too often`;
    else div.innerHTML = `⌁ ${nm(f.victim, f.victimColor)} fled the game`;
    this.feed.prepend(div);
    while (this.feed.children.length > 6) this.feed.lastChild.remove();
    setTimeout(() => div.classList.add('out'), 7000);
    setTimeout(() => div.remove(), 7700);
  }

  addChat(m) {
    const div = document.createElement('div');
    div.className = `m${m.ghost ? ' ghost' : ''}`;
    div.innerHTML = `<b style="color:${m.color}">${m.ghost ? '👻 ' : ''}${escapeHtml(m.name)}</b>${escapeHtml(m.text)}`;
    this.chatLog.append(div);
    while (this.chatLog.children.length > 30) this.chatLog.firstChild.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  codeChanged() {
    this.mycode.classList.remove('changed');
    void this.mycode.offsetWidth;
    this.mycode.classList.add('changed');
    this.glimpses = [];
    this.selfCodeUntil = 0;
  }

  setHint(html) {
    if (this.hint.innerHTML !== html) this.hint.innerHTML = html;
  }

  setMapLabel(text) {
    this.weather.innerHTML = `<span class="ico">🌫</span><span class="lbl">${escapeHtml(text)}</span>`;
  }

  /** Full-screen death card: "ELIMINATED BY <name>" in the killer's colour + how long you survived. */
  showDeath({ cause, by, color, survivedMs }) {
    const secs = Math.max(0, Math.round((survivedMs || 0) / 1000));
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    let title;
    if (cause === 'kill' && by) title = `ELIMINATED BY <b style="color:${color || '#ff3860'};text-shadow:0 0 24px ${color || '#ff3860'}">${escapeHtml(by)}</b>`;
    else if (cause === 'zone') title = '<b class="zone">CONSUMED BY THE ZONE</b>';
    else if (cause === 'guesses') title = '<b>TOO MANY WRONG GUESSES</b>';
    else title = '<b>ELIMINATED</b>';
    const next = cause === 'kill' && by ? `Watching ${escapeHtml(by)} in a moment…` : 'Watching the nearest survivor in a moment…';
    this.death.innerHTML = `<div class="dt">${title}</div><div class="ds">You survived <b>${time}</b></div><div class="dn">${next}</div>`;
    this.death.classList.add('on');
  }

  hideDeath() {
    this.death?.classList.remove('on');
  }

  // ---------------------------------------------------------------- inventory
  setInventory(inv, dropMode) {
    const key = `${inv.join(',')}|${dropMode}`;
    if (key === this.invKey) return;
    this.invKey = key;
    this.inventory.classList.toggle('drop', !!dropMode);
    inv.forEach((id, i) => {
      const slot = this.slots[i];
      const def = id ? ITEMS[id] : null;
      slot.classList.toggle('empty', !def);
      slot.style.setProperty('--rc', def ? RARITY_COLOR[def.rarity] : 'rgba(255,255,255,0.15)');
      slot.querySelector('.icon').textContent = def ? def.icon : '';
      slot.querySelector('.nm').textContent = def ? def.name : 'empty';
      slot.querySelector('.tip').innerHTML = def ? `<b style="color:${RARITY_COLOR[def.rarity]}">${escapeHtml(def.name)}</b> <i>${def.rarity}</i><br>${escapeHtml(def.desc)}` : 'Walk over glowing items to pick them up';
    });
  }

  flashSlot(i) {
    const s = this.slots[i];
    if (!s) return;
    s.classList.remove('used');
    void s.offsetWidth;
    s.classList.add('used');
  }

  itemToast(item, text) {
    const def = ITEMS[item];
    this.announce(def ? `${def.icon} ${def.name.toUpperCase()}` : text, def ? def.desc : '', def ? def.color : '#fff', 2600);
  }

  // ---------------------------------------------------------------- special panels
  showGlimpse(digit, pos, source) {
    this.glimpses.push({ pos, digit, until: performance.now() + 4500 });
    this.glimpse.innerHTML = `${source === 'puddle' ? '💧' : '🪞'} You glimpse a <b>${escapeHtml(digit)}</b> in the ${source === 'puddle' ? 'puddle' : 'mirror'}… <span>position ${pos}</span>`;
    this.glimpse.classList.remove('on');
    void this.glimpse.offsetWidth;
    this.glimpse.classList.add('on');
    clearTimeout(this.glimpseTimer);
    this.glimpseTimer = setTimeout(() => this.glimpse.classList.remove('on'), 4200);
  }

  showSelfCode(code, ms) {
    this.selfCode = code;
    this.selfCodeUntil = performance.now() + ms;
  }

  updateMyCode() {
    const now = performance.now();
    let txt;
    let revealed = false;
    if (this.selfCodeUntil > now && this.selfCode) {
      txt = this.selfCode.split('').join(' ');
      revealed = true;
    } else {
      const d = ['?', '?', '?', '?'];
      this.glimpses = this.glimpses.filter((g) => g.until > now);
      for (const g of this.glimpses) d[g.pos - 1] = g.digit;
      txt = d.join(' ');
      revealed = this.glimpses.length > 0;
    }
    if (this.mycodeDigits.textContent !== txt) this.mycodeDigits.textContent = txt;
    this.mycode.classList.toggle('revealed', revealed);
  }

  showReward(ms, onChoose) {
    this.onRewardChoice = (c) => {
      this.reward.classList.remove('on');
      onChoose(c);
    };
    this.rewardUntil = performance.now() + ms;
    this.reward.classList.add('on');
  }

  hideReward() {
    this.reward.classList.remove('on');
  }

  lightsOutWarning(ms) {
    this.loWarn.classList.add('on');
    clearTimeout(this.loTimer);
    this.loTimer = setTimeout(() => this.loWarn.classList.remove('on'), ms);
  }

  setVent(on, html = '') {
    this.vent.classList.toggle('on', on);
    const help = this.vent.querySelector('.vent-help');
    if (help.innerHTML !== html) help.innerHTML = html;
  }

  setSecurity(on, cams = []) {
    if (on && !this.security.classList.contains('on')) {
      const cells = this.security.querySelectorAll('.cam');
      cells.forEach((c, i) => {
        c.style.display = cams[i] ? '' : 'none';
        c.querySelector('.cam-label').textContent = cams[i] ? cams[i].name : '';
      });
    }
    this.security.classList.toggle('on', on);
  }

  // ---------------------------------------------------------------- per-snapshot
  update(snap, local) {
    const me = snap.me;
    this.alive.textContent = `${snap.alive}/${snap.total}`;
    const z = snap.zone;
    if (snap.grace > 0) {
      this.zoneLabel.textContent = 'GRACE';
      this.zoneTimer.textContent = fmt(snap.grace);
    } else if (z.phase === 'final') {
      this.zoneLabel.textContent = 'ZONE';
      this.zoneTimer.textContent = 'FINAL';
    } else {
      this.zoneLabel.textContent = z.phase === 'shrink' ? 'SHRINKING' : `ZONE ${z.stage + 1}`;
      this.zoneTimer.textContent = fmt(z.ms);
    }
    this.levelPill.textContent = me.lv === 1 ? 'UPSTAIRS' : me.lv === -1 ? 'BASEMENT' : 'GROUND';

    const gs = Math.ceil(snap.grace / 1000);
    if (snap.grace > 0) {
      if (gs !== this.lastGraceSec) {
        this.grace.innerHTML = `<span class="n">${gs}</span><small>GRACE PERIOD · NO KILLS</small>`;
        this.grace.classList.add('show');
        if (gs <= 5) sfx.beep(false);
      }
    } else if (this.lastGraceSec > 0) {
      this.grace.classList.remove('show');
      sfx.beep(true);
      this.announce('HUNT BEGINS', 'Kills are live', '#ff3860');
    }
    this.lastGraceSec = snap.grace > 0 ? gs : 0;

    this.hpBar.style.width = `${me.hp}%`;
    this.hpText.textContent = me.alive ? me.hp : 'DEAD';
    if (me.hp < this.lastHp && me.alive) sfx.hurt();
    this.lastHp = me.hp;
    this.vignette.classList.toggle('on', !!me.out && !!me.alive);

    // Bounty banner
    const b = snap.bounty;
    if (b) {
      const mine = b.id === local.id;
      const name = local.nameOf(b.id);
      this.bountyBanner.innerHTML = mine
        ? `💰 <b>YOU ARE THE BOUNTY</b> · survive ${Math.ceil(b.ms / 1000)}s for a reward`
        : `💰 BOUNTY: <b>${escapeHtml(name)}</b> · ${Math.ceil(b.ms / 1000)}s`;
      this.bountyBanner.classList.add('on');
      this.bountyBanner.classList.toggle('mine', mine);
    } else this.bountyBanner.classList.remove('on');

    // Chips
    const chips = [];
    if (!me.alive) chips.push(['GHOST', 'cyan']);
    if (me.hidden) chips.push(['HIDDEN', 'green']);
    if (me.lockMs > 0) chips.push([`LOCKED ${(me.lockMs / 1000).toFixed(1)}s`, 'red']);
    if (me.revealMs > 0) chips.push([`REVEALED ${Math.ceil(me.revealMs / 1000)}s`, 'red']);
    if (me.hoodMs > 0) chips.push([`HOOD ${Math.ceil(me.hoodMs / 1000)}s`, 'green']);
    if (me.flash) chips.push(['🔦 FLASHLIGHT', 'yellow']);
    if (local.crouch && me.alive) chips.push(['CROUCH · SILENT', 'yellow']);
    if (snap.lo && snap.lo.phase === 'on') chips.push([`LIGHTS OUT ${Math.ceil(snap.lo.ms / 1000)}s`, 'pink']);
    if (me.wrong > 0 && local.penalty === 'death' && me.alive) chips.push([`WRONG ${me.wrong}/${local.deathAfter}`, 'red']);
    if (me.kills > 0) chips.push([`KILLS ${me.kills}`, 'yellow']);
    const html = chips.map(([t, c]) => `<span class="chip ${c}">${t}</span>`).join('');
    if (this.chips.innerHTML !== html) this.chips.innerHTML = html;

    this.slats.classList.toggle('on', me.lk !== null && me.alive === 1);
    if (me.alive) this.setInventory(me.inv || [null, null], local.dropMode);
    this.inventory.classList.toggle('hidden', !me.alive);
    if (!me.reward && this.reward.classList.contains('on')) this.hideReward();
    else if (me.reward) this.reward.querySelector('.reward-timer').textContent = `${Math.ceil(me.reward / 1000)}s`;
  }

  // ---------------------------------------------------------------- minimap
  buildMapLayers(map) {
    const W = this.minimap.width;
    const s = W / map.size;
    const tx = (x) => (x + map.size / 2) * s;
    this.mapLayers = {};
    for (const lv of map.levels) {
      const c = document.createElement('canvas');
      c.width = c.height = W;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(8,5,14,0.92)';
      g.fillRect(0, 0, W, W);
      for (const h of map.houses) {
        g.fillStyle = lv === 0 ? 'rgba(60,50,80,0.45)' : 'rgba(60,50,80,0.25)';
        g.fillRect(tx(h.minX), tx(h.minZ), (h.maxX - h.minX) * s, (h.maxZ - h.minZ) * s);
      }
      for (const f of map.floors) {
        if (f.level !== lv || lv === 0) continue;
        g.fillStyle = lv === -1 ? 'rgba(20,10,20,0.9)' : 'rgba(80,70,110,0.5)';
        g.fillRect(tx(f.minX), tx(f.minZ), (f.maxX - f.minX) * s, (f.maxZ - f.minZ) * s);
      }
      if (lv === 0) {
        g.fillStyle = 'rgba(40,110,60,0.6)';
        for (const b of map.bushes) {
          g.beginPath();
          g.arc(tx(b.x), tx(b.z), b.r * s, 0, Math.PI * 2);
          g.fill();
        }
      }
      for (const b of map.boxes) {
        if (b.level !== lv) continue;
        g.fillStyle = b.kind === 'locker' || b.kind === 'wardrobe' ? '#67d2e6' : b.sight ? '#6a6480' : b.solid !== false ? '#3a3245' : 'rgba(0,0,0,0)';
        g.fillRect(tx(b.minX), tx(b.minZ), Math.max(1, (b.maxX - b.minX) * s), Math.max(1, (b.maxZ - b.minZ) * s));
      }
      g.fillStyle = '#9aa7ff';
      for (const v of map.vents) if (v.level === lv) g.fillRect(tx(v.x) - 1.5, tx(v.z) - 1.5, 3, 3);
      g.fillStyle = '#ffd23f';
      for (const st of map.stairs) for (const e of [st.a, st.b]) if (e.level === lv) g.fillRect(tx(e.x) - 1.5, tx(e.z) - 1.5, 3, 3);
      this.mapLayers[lv] = c;
    }
  }

  drawMinimap(map, snap, self, chars, extras) {
    if (!this.mapLayers) this.buildMapLayers(map);
    const c = this.mctx;
    const W = this.minimap.width;
    const s = W / map.size;
    const tx = (x) => (x + map.size / 2) * s;
    const lv = self.alive ? self.level : 0;
    c.drawImage(this.mapLayers[lv] || this.mapLayers[0], 0, 0);
    // Doors on this level (red = locked)
    const doors = extras.doors || '';
    for (const d of map.doors) {
      if (d.level !== lv) continue;
      const st = doors[d.id];
      c.fillStyle = st === '2' ? '#ff2040' : st === '1' ? 'rgba(90,255,150,0.5)' : '#8a6a4a';
      c.fillRect(tx(d.minX), tx(d.minZ), Math.max(2, (d.maxX - d.minX) * s), Math.max(2, (d.maxZ - d.minZ) * s));
    }
    const z = snap.zone;
    c.strokeStyle = '#ff3860';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(tx(z.x), tx(z.z), Math.max(0, z.r * s), 0, Math.PI * 2);
    c.stroke();
    if (z.phase !== 'final' && z.tr < z.r) {
      c.strokeStyle = 'rgba(255,255,255,0.6)';
      c.setLineDash([3, 3]);
      c.lineWidth = 1;
      c.beginPath();
      c.arc(tx(z.tx), tx(z.tz), z.tr * s, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    }
    for (const pk of extras.pickups || []) {
      if ((pk.level ?? 0) !== lv) continue;
      c.fillStyle = pk.type === 'hood' ? '#5effa1' : ITEMS[pk.item]?.color || '#fff';
      c.fillRect(tx(pk.x) - 2, tx(pk.z) - 2, 4, 4);
    }
    // Players worth showing: revealed (penalty) and the bounty; ghosts see everyone
    const bountyId = snap.bounty?.id;
    for (const p of snap.ps) {
      if (p.id === self.id) continue;
      const ch = chars.get(p.id);
      if (!ch) continue;
      const show = p.rv || p.id === bountyId || !snap.me.alive;
      if (!show) continue;
      const x = tx(ch.root.position.x);
      const y = tx(ch.root.position.z);
      if (p.id === bountyId) {
        c.font = '12px sans-serif';
        c.textAlign = 'center';
        c.fillText('💰', x, y + 4);
        continue;
      }
      c.fillStyle = p.rv ? '#ff2050' : ch.color;
      c.beginPath();
      c.arc(x, y, p.rv ? 4 : p.id === extras.spectateId ? 4 : 2.5, 0, Math.PI * 2);
      c.fill();
      if (p.id === extras.spectateId) {
        c.strokeStyle = '#fff';
        c.stroke();
      }
    }
    c.save();
    c.translate(tx(self.x), tx(self.z));
    c.rotate(-self.viewYaw);
    c.fillStyle = self.alive ? '#fff' : '#3ec7ff';
    c.beginPath();
    c.moveTo(0, -6);
    c.lineTo(4, 4);
    c.lineTo(-4, 4);
    c.closePath();
    c.fill();
    c.restore();
  }
}
