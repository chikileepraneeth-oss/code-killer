import { io } from 'socket.io-client';
import './styles.css';
import './styles-v2.css';
import { initAudio, sfx } from './audio.js';
import { Game } from './game/game.js';
import { escapeHtml, Hud } from './ui/hud.js';
import { sizeLabelFor, zoneStartRadius } from '@shared/constants.js';
import { getQualityKey, setQualityKey } from './quality.js';

for (const sel of document.querySelectorAll('.quality-select')) {
  sel.value = getQualityKey();
  sel.addEventListener('change', () => {
    setQualityKey(sel.value);
    for (const other of document.querySelectorAll('.quality-select')) other.value = sel.value;
  });
}

const $ = (id) => document.getElementById(id);
// The game server is hosted separately (e.g. Render); set VITE_SERVER_URL at build time.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';
const socket = io(SERVER_URL, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 4000,
  timeout: 20000,
});
const hud = new Hud();

const state = {
  selfId: null,
  room: null, // latest lobby state
  game: null,
  pendingOver: null,
};

if (import.meta.env.DEV) window.__ck = state; // dev-only debugging handle

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ------------------------------------------------------------------ helpers
function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === screen);
  document.body.classList.toggle('ingame', screen === 'hud');
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ------------------------------------------------------------------ connection / cold start
// Free hosting plans sleep when idle: the first connection can take up to a minute.
const WAKE_AFTER_MS = 5000;
let wakeTimer = null;
let wakeTicker = null;
function setServerStatus(text) {
  const el = $('server-status');
  el.textContent = text;
  el.classList.toggle('on', !!text);
}
function startWakeWatch() {
  clearTimeout(wakeTimer);
  clearInterval(wakeTicker);
  const t0 = Date.now();
  wakeTimer = setTimeout(() => {
    const tick = () => setServerStatus(`Server is waking up, this can take up to a minute… (${Math.round((Date.now() - t0) / 1000)}s, retrying automatically)`);
    tick();
    wakeTicker = setInterval(() => {
      tick();
      // socket.io keeps retrying on its own; also make sure it hasn't given up
      if (!socket.connected && !socket.active) socket.connect();
    }, 1000);
  }, WAKE_AFTER_MS);
}
function stopWakeWatch() {
  clearTimeout(wakeTimer);
  clearInterval(wakeTicker);
  setServerStatus('');
}
startWakeWatch();

function whenConnected(ms = 75000) {
  if (socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(t);
      socket.off('connect', onConnect);
      resolve(v);
    };
    const onConnect = () => done(true);
    const t = setTimeout(() => done(false), ms);
    socket.on('connect', onConnect);
  });
}

const call = async (ev, data) => {
  if (!(await whenConnected())) return { ok: false, error: 'Cannot reach the game server — please try again' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Server did not respond' }), 8000);
    socket.emit(ev, data, (res) => {
      clearTimeout(timer);
      resolve(res || { ok: false });
    });
  });
};

window.addEventListener('pointerdown', initAudio);
window.addEventListener('keydown', initAudio);

// 3D tilt on cards following the mouse (menus only)
document.addEventListener('mousemove', (e) => {
  if (state.game) return;
  for (const c of document.querySelectorAll('.screen.active .card3d')) {
    const r = c.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
    const dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
    c.style.transform = `rotateY(${dx * 8}deg) rotateX(${-dy * 8}deg)`;
  }
});

// ------------------------------------------------------------------ home
const nameInput = $('name-input');
const codeInput = $('code-input');
nameInput.value = store.get('ck-name') || '';
// Share links: https://<site>/<ROOMCODE> (or the older ?room=CODE) pre-fill the join box
const pathRoom = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));
const urlRoom = /^[A-Za-z0-9]{6}$/.test(pathRoom) ? pathRoom : new URLSearchParams(location.search).get('room');
if (urlRoom) {
  codeInput.value = urlRoom.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  setTimeout(() => (nameInput.value ? $('join-btn') : nameInput).focus(), 0);
}

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[01OI]/g, '');
});

function getName() {
  const n = nameInput.value.trim();
  if (!n) {
    $('home-error').textContent = 'Enter a name first';
    nameInput.focus();
    return null;
  }
  store.set('ck-name', n);
  return n;
}

$('create-btn').addEventListener('click', async () => {
  const name = getName();
  if (!name) return;
  const res = await call('room:create', { name });
  if (!res.ok) return void ($('home-error').textContent = res.error || 'Could not create room');
  enterLobby(res);
});

async function join() {
  const name = getName();
  if (!name) return;
  const code = codeInput.value.trim();
  if (code.length !== 6) return void ($('home-error').textContent = 'Room codes are 6 characters');
  const res = await call('room:join', { code, name });
  if (!res.ok) return void ($('home-error').textContent = res.error || 'Could not join');
  enterLobby(res);
}
$('join-btn').addEventListener('click', join);
codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && join());
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && (codeInput.value.length === 6 ? join() : $('create-btn').click()));

function enterLobby(res) {
  state.selfId = res.selfId;
  $('home-error').textContent = '';
  $('lobby-chat').innerHTML = '';
  history.replaceState(null, '', `/${res.code}`);
  renderLobby();
  if (res.phase !== 'playing' && !state.game) show('lobby');
}

// ------------------------------------------------------------------ lobby
const settingsForm = $('settings');

function renderLobby() {
  const r = state.room;
  if (!r) return;
  const isHost = r.hostId === state.selfId;
  document.body.classList.toggle('is-host', isHost);
  $('room-code-text').textContent = r.code;
  $('player-count').textContent = `${r.players.length}/${r.settings.maxPlayers}`;
  $('player-list').innerHTML = r.players
    .map((p) => `<li style="--c:${p.color}"><span class="dot"></span><span class="nm">${escapeHtml(p.name)}</span>${p.isHost ? '<span class="tag host">host</span>' : ''}${p.isBot ? '<span class="tag bot">bot</span>' : ''}${p.id === state.selfId ? '<span class="tag you">you</span>' : ''}</li>`)
    .join('');

  const n = r.players.length;
  $('map-size').textContent = `Foggy Village (fixed map) · ${n} player${n === 1 ? '' : 's'} · ${sizeLabelFor(n)}: the zone starts ${zoneStartRadius(n) * 2} m wide`;
  for (const [k, v] of Object.entries(r.settings)) {
    const el = settingsForm.elements[k];
    if (!el || el === document.activeElement) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  for (const l of settingsForm.querySelectorAll('[data-pen]')) l.style.display = l.dataset.pen === r.settings.penaltyType ? '' : 'none';
  settingsForm.classList.toggle('readonly', !isHost);
  $('settings-note').textContent = isHost ? '' : '(host only)';
  const start = $('start-btn');
  start.style.display = isHost ? '' : 'none';
  start.disabled = r.players.length < 2 || r.phase !== 'lobby';
  $('lobby-msg').textContent = r.phase === 'playing'
    ? 'A round is in progress…'
    : r.players.length < 2 ? (isHost ? 'Need at least 2 players — invite friends or add bots.' : 'Waiting for players…')
      : isHost ? '' : 'Waiting for the host to start…';
}

settingsForm.addEventListener('change', async (e) => {
  const el = e.target;
  const patch = { [el.name]: el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value };
  const res = await call('room:settings', patch);
  if (!res.ok) toast(res.error);
});
settingsForm.addEventListener('submit', (e) => e.preventDefault());

$('room-code').addEventListener('click', async () => {
  const code = state.room?.code;
  if (!code) return;
  const link = `${location.origin}/${code}`;
  try {
    await navigator.clipboard.writeText(code);
    toast(`Copied ${code} · share link: ${link}`);
  } catch {
    toast(`Room code: ${code}`);
  }
});

$('add-bot').addEventListener('click', async () => {
  const res = await call('room:addBot');
  if (!res.ok) toast(res.error);
});
$('remove-bot').addEventListener('click', async () => {
  const res = await call('room:removeBot');
  if (!res.ok) toast(res.error);
});
$('start-btn').addEventListener('click', async () => {
  const res = await call('room:start');
  if (!res.ok) toast(res.error);
});
$('leave-btn').addEventListener('click', async () => {
  await call('room:leave');
  state.room = null;
  history.replaceState(null, '', '/');
  show('home');
});

$('lobby-chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.querySelector('input');
  const text = input.value.trim();
  if (text) socket.emit('chat', { text });
  input.value = '';
});

function lobbyChat(m) {
  const log = $('lobby-chat');
  const div = document.createElement('div');
  div.className = 'm';
  div.innerHTML = `<b style="color:${m.color}">${escapeHtml(m.name)}</b>${escapeHtml(m.text)}`;
  log.append(div);
  log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------------ socket events
socket.on('room:state', (r) => {
  state.room = r;
  renderLobby();
  state.game?.setRoster(r.players);
});

socket.on('chat', (m) => {
  if (!state.game) lobbyChat(m);
});

socket.on('game:start', (start) => {
  if (state.game) {
    state.game.dispose();
    state.game = null;
  }
  clearTimeout(state.pendingOver);
  hud.reset();
  show('hud');
  state.game = new Game({ socket, start, roster: state.room?.players || [], hud, onToast: toast });
});

socket.on('game:over', (over) => {
  // Let the final kill play out for a moment, then show the winner
  state.pendingOver = setTimeout(() => {
    state.game?.dispose();
    state.game = null;
    showWin(over);
  }, 1800);
});

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showWin(over) {
  const name = $('win-name');
  name.textContent = over.winnerName || 'Nobody';
  name.style.setProperty('--wc', over.winnerColor || '#fff');
  document.querySelector('.win-sub').textContent = `LAST ONE STANDING · ${over.mapName || ''}`;
  $('stats-body').innerHTML = over.stats
    .map((p, i) => `<tr class="${p.place === 1 ? 'first' : ''}" style="animation-delay:${0.4 + i * 0.08}s"><td>${p.place}</td><td><b style="color:${p.color}">${escapeHtml(p.name)}</b>${p.isBot ? ' <span class="tag bot">bot</span>' : ''}${p.id === state.selfId ? ' <span class="tag you">you</span>' : ''}</td><td class="code">${p.code || '----'}</td><td>${p.kills}</td><td>${fmtTime(p.survivedMs)}</td><td>${p.wrongGuesses}</td></tr>`)
    .join('');
  show('win');
  if (over.winnerId === state.selfId) sfx.win();
}

$('back-lobby').addEventListener('click', async () => {
  const res = await call('room:sync');
  if (res.ok) {
    state.room = res.state;
    renderLobby();
    show('lobby');
  } else show('home');
});

socket.on('disconnect', () => {
  if (state.game) {
    state.game.dispose();
    state.game = null;
  }
  if (state.room) toast('Disconnected from server');
  state.room = null;
  show('home');
});

socket.on('connect', () => {
  stopWakeWatch();
  if ($('home-error').textContent.startsWith('Cannot reach')) $('home-error').textContent = '';
});
socket.on('disconnect', () => startWakeWatch());
