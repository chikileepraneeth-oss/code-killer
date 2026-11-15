import { sfx } from '../audio.js';

const REASONS = {
  grace: 'GRACE PERIOD — NO KILLS YET',
  locked: 'LOCKED OUT',
  rate_limited: 'TOO FAST — TRY AGAIN',
  invalid: 'NEED 4 DIGITS',
  killbox_closed: 'TRY AGAIN',
  not_allowed: 'NOT ALLOWED',
};

const IDLE_CLEAR_MS = 4000; // a half-typed code clears itself (and you get your speed back)

/**
 * The code bar: always on screen while you can strike. Just type digits — they appear here as you
 * type, and the 4th digit strikes automatically (no key to open it, no Enter).
 * While digits are entered you count as "typing": slowed down and shown as TYPING to others.
 */
export class KillBox {
  constructor(el, { onSubmit, onToggle }) {
    this.el = el;
    this.cells = [...el.querySelectorAll('.flip')];
    this.msg = el.querySelector('.kb-msg');
    this.lockBar = el.querySelector('.kb-lock-bar');
    this.onSubmit = onSubmit;
    this.onToggle = onToggle;
    this.value = '';
    this.typing = false; // server knows we're typing (slowed, TYPING tag)
    this.visible = false;
    this.flipped = this.cells.map(() => false);
    this.lockUntil = 0;
    this.lockTotal = 1;
    this.pending = false;
    this.lastKeyAt = 0;
    this.msgTimer = null;
    this.render();
  }

  /** True while a code is being typed or checked (used for the 20% speed while typing). */
  get isOpen() {
    return this.typing;
  }

  showChar(i, ch) {
    const cell = this.cells[i];
    const front = cell.querySelector('.front');
    const back = cell.querySelector('.back');
    const visible = this.flipped[i] ? back : front;
    if (visible.textContent === ch) return;
    if (this.flipped[i]) front.textContent = ch;
    else back.textContent = ch;
    this.flipped[i] = !this.flipped[i];
    cell.classList.toggle('flipped', this.flipped[i]);
  }

  render() {
    for (let i = 0; i < 4; i++) {
      this.showChar(i, this.value[i] ?? '_');
      this.cells[i].classList.toggle('cursor', this.visible && !this.pending && i === this.value.length);
    }
    this.el.classList.toggle('typing', this.value.length > 0 || this.pending);
  }

  /** Shown while you're alive and able to strike (hidden when dead, in a vent, on the monitors...). */
  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    this.el.classList.toggle('open', on);
    if (!on) this.clear(true);
    this.render();
  }

  setTyping(on) {
    if (on === this.typing) return;
    this.typing = on;
    this.onToggle(on);
  }

  setMsg(text, cls = '', ms = 2200) {
    this.msg.textContent = text;
    this.msg.className = `kb-msg ${cls}`;
    clearTimeout(this.msgTimer);
    if (text && ms) this.msgTimer = setTimeout(() => this.setMsg(''), ms);
  }

  /** A digit key (top row or numpad). Returns true if it was used. */
  typeDigit(d) {
    if (!this.visible || this.pending) return false;
    const now = performance.now();
    if (now < this.lockUntil) {
      this.setMsg(`LOCKED — ${Math.ceil((this.lockUntil - now) / 1000)}s`, 'bad', 1200);
      this.shake();
      return true;
    }
    if (this.value.length >= 4) return true;
    if (!this.value) this.setMsg('');
    this.value += d;
    this.lastKeyAt = now;
    this.setTyping(true);
    sfx.key();
    this.render();
    if (this.value.length === 4) this.submit();
    return true;
  }

  backspace() {
    if (!this.value || this.pending) return false;
    this.value = this.value.slice(0, -1);
    this.lastKeyAt = performance.now();
    sfx.click();
    if (!this.value) this.setTyping(false);
    this.render();
    return true;
  }

  /** Throw away the digits typed so far. */
  clear(silent = false) {
    if (this.pending) return false;
    const had = this.value.length > 0;
    this.value = '';
    this.setTyping(false);
    this.render();
    if (had && !silent) sfx.close();
    return had;
  }

  submit() {
    if (this.pending || this.value.length !== 4) return;
    this.pending = true;
    this.setMsg('STRIKING…', 'info', 0);
    this.render();
    this.onSubmit(this.value);
  }

  shake() {
    this.el.classList.remove('shake');
    void this.el.offsetWidth;
    this.el.classList.add('shake');
  }

  result(res) {
    this.pending = false;
    this.value = '';
    this.setTyping(false);
    this.render();
    if (res.ok) {
      this.setMsg(`ELIMINATED ${String(res.victim || '').toUpperCase()}`, 'good');
      return;
    }
    if (res.reason === 'wrong') {
      sfx.wrong();
      this.shake();
      let text = 'WRONG CODE';
      if (res.penalty === 'lockout') text += ` — LOCKED ${Math.round(res.ms / 1000)}s`;
      if (res.penalty === 'reveal') text += ' — YOUR LOCATION IS REVEALED';
      if (res.penalty === 'death') text += res.died ? ' — YOU PAID THE PRICE' : ` — ${res.guessesLeft} LEFT BEFORE DEATH`;
      this.setMsg(text, 'bad', 3200);
      if (res.ms) this.setLock(res.ms);
      return;
    }
    if (res.reason === 'locked' && res.ms) this.setLock(res.ms);
    if (res.reason === 'grace' && res.ms) this.setMsg(`${REASONS.grace} (${Math.ceil(res.ms / 1000)}s)`, 'bad');
    else this.setMsg(REASONS[res.reason] || 'FAILED', 'bad');
  }

  setLock(ms) {
    this.lockUntil = performance.now() + ms;
    this.lockTotal = ms;
  }

  /** Called every frame; server lockMs keeps us honest. */
  update(serverLockMs) {
    const now = performance.now();
    if (serverLockMs > 0 && now + serverLockMs > this.lockUntil + 200) this.setLock(serverLockMs);
    const left = Math.max(0, this.lockUntil - now);
    this.lockBar.style.width = `${(left / this.lockTotal) * 100}%`;
    this.el.classList.toggle('locked', left > 0);
    // Stopped half-way: clear so you're not stuck slowed down with TYPING over your head
    if (this.value && !this.pending && now - this.lastKeyAt > IDLE_CLEAR_MS) {
      this.clear();
      this.setMsg('CLEARED — TYPE AGAIN', 'info', 1500);
    }
  }

  reset() {
    this.pending = false;
    this.value = '';
    this.typing = false;
    this.lockUntil = 0;
    this.el.classList.remove('locked', 'shake', 'typing');
    this.setMsg('');
    this.render();
  }
}
