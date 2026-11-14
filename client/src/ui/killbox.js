import { sfx } from '../audio.js';

const REASONS = {
  grace: 'GRACE PERIOD — NO KILLS YET',
  locked: 'LOCKED OUT',
  rate_limited: 'TOO FAST',
  invalid: 'NEED 4 DIGITS',
  killbox_closed: 'KILL BOX CLOSED',
  not_allowed: 'NOT ALLOWED',
};

export class KillBox {
  constructor(el, { onSubmit, onToggle }) {
    this.el = el;
    this.cells = [...el.querySelectorAll('.flip')];
    this.msg = el.querySelector('.kb-msg');
    this.lockBar = el.querySelector('.kb-lock-bar');
    this.onSubmit = onSubmit;
    this.onToggle = onToggle;
    this.isOpen = false;
    this.value = '';
    this.flipped = this.cells.map(() => false);
    this.lockUntil = 0;
    this.lockTotal = 1;
    this.pending = false;
    this.render();
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
      this.cells[i].classList.toggle('cursor', this.isOpen && i === this.value.length);
    }
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.value = '';
    this.setMsg('');
    this.el.classList.add('open');
    this.render();
    sfx.open();
    this.onToggle(true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('open');
    sfx.close();
    this.onToggle(false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  setMsg(text, cls = '') {
    this.msg.textContent = text;
    this.msg.className = `kb-msg ${cls}`;
  }

  /** Returns true if the key was consumed. */
  handleKey(e) {
    if (!this.isOpen) return false;
    if (/^[0-9]$/.test(e.key)) {
      if (this.value.length < 4) {
        this.value += e.key;
        sfx.key();
        this.render();
      }
      return true;
    }
    if (e.key === 'Backspace') {
      this.value = this.value.slice(0, -1);
      sfx.click();
      this.render();
      return true;
    }
    if (e.key === 'Enter') {
      this.submit();
      return true;
    }
    if (e.key === 'Escape') {
      this.close();
      return true;
    }
    return false;
  }

  submit() {
    if (this.pending) return;
    if (performance.now() < this.lockUntil) {
      this.setMsg(REASONS.locked, 'bad');
      return;
    }
    if (this.value.length !== 4) {
      this.setMsg(REASONS.invalid, 'bad');
      this.shake();
      return;
    }
    this.pending = true;
    this.onSubmit(this.value);
  }

  shake() {
    this.el.classList.remove('shake');
    void this.el.offsetWidth;
    this.el.classList.add('shake');
  }

  result(res) {
    this.pending = false;
    if (res.ok) {
      this.setMsg(`ELIMINATED ${res.victim.toUpperCase()}`, 'good');
      this.value = '';
      this.render();
      setTimeout(() => this.close(), 700);
      return;
    }
    if (res.reason === 'wrong') {
      sfx.wrong();
      this.shake();
      let text = 'WRONG CODE';
      if (res.penalty === 'lockout') text += ` — LOCKED ${Math.round(res.ms / 1000)}s`;
      if (res.penalty === 'reveal') text += ' — YOUR LOCATION IS REVEALED';
      if (res.penalty === 'death') text += res.died ? ' — YOU PAID THE PRICE' : ` — ${res.guessesLeft} LEFT BEFORE DEATH`;
      this.setMsg(text, 'bad');
      this.value = '';
      this.render();
      if (res.ms) this.setLock(res.ms);
      return;
    }
    if (res.reason === 'locked' && res.ms) this.setLock(res.ms);
    this.setMsg(REASONS[res.reason] || 'FAILED', 'bad');
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
  }

  reset() {
    this.isOpen = false;
    this.pending = false;
    this.value = '';
    this.lockUntil = 0;
    this.el.classList.remove('open', 'locked', 'shake');
    this.setMsg('');
    this.render();
  }
}
