import assert from 'node:assert/strict';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createGameServer } from '../src/index.js';

const call = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

test('socket: create room, join by code, add bot, start game, receive snapshots', async () => {
  const srv = await createGameServer({ port: 0, log: false });
  const url = `http://localhost:${srv.port}`;
  const a = io(url, { transports: ['websocket'] });
  const b = io(url, { transports: ['websocket'] });
  try {
    const created = await call(a, 'room:create', { name: 'Alice' });
    assert.equal(created.ok, true);
    assert.match(created.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal((await call(b, 'room:join', { code: 'ZZZZZZ', name: 'Bob' })).ok, false);
    assert.equal((await call(b, 'room:join', { code: created.code.toLowerCase(), name: 'Bob' })).ok, true);
    assert.equal((await call(b, 'room:start', {})).ok, false); // not host
    assert.equal((await call(a, 'room:addBot', {})).ok, true);
    const snap = new Promise((r) => b.once('snap', r));
    assert.equal((await call(a, 'room:start', {})).ok, true);
    const s = await snap;
    assert.equal(s.ps.length, 3);
    assert.equal(s.codes[b.id], undefined);
  } finally {
    a.close();
    b.close();
    await srv.close();
  }
});

test('socket: new v2 events respond; debug commands are disabled unless CK_DEBUG=1', async () => {
  delete process.env.CK_DEBUG;
  const srv = await createGameServer({ port: 0, log: false });
  const a = io(`http://localhost:${srv.port}`, { transports: ['websocket'] });
  const withTimeout = (p, ms = 500) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
  try {
    await call(a, 'room:create', { name: 'Alice' });
    await call(a, 'room:addBot', {});
    const start = new Promise((r) => a.once('game:start', r));
    await call(a, 'room:start', {});
    const gs = await start;
    assert.ok(gs.map && gs.map.houses.length > 0, 'generated map is sent with game:start');
    assert.equal(typeof (await call(a, 'interact', {})).ok, 'boolean');
    assert.equal((await call(a, 'item:use', { slot: 0 })).ok, false, 'empty slot');
    assert.equal((await call(a, 'bounty:choose', { choice: 'reveal' })).ok, false, 'no reward pending');
    assert.equal(await withTimeout(call(a, 'dev:tp', { x: 0, z: 0 })), 'timeout', 'debug teleport not available');
    assert.equal(await withTimeout(call(a, 'dev:give', { item: 'armor' })), 'timeout', 'debug give not available');
  } finally {
    a.close();
    await srv.close();
  }
});

test('deployment: /health, /stats behind STATS_KEY, client origin allow-list', async () => {
  const env = { NODE_ENV: 'production', CLIENT_ORIGIN: 'https://ck.netlify.app', STATS_KEY: 's3cret' };
  const srv = await createGameServer({ port: 0, log: false, env });
  const base = `http://localhost:${srv.port}`;
  try {
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.equal(await h.text(), 'ok');
    assert.equal((await fetch(`${base}/stats`)).status, 401);
    assert.equal((await fetch(`${base}/stats?key=wrong`)).status, 401);
    const st = await (await fetch(`${base}/stats?key=s3cret`)).json();
    for (const k of ['playersOnline', 'rooms', 'tick', 'memoryMB', 'uptimeSeconds']) assert.ok(k in st, k);
    assert.ok('avgMs' in st.tick && 'maxMs' in st.tick);
    assert.equal((await fetch(`${base}/`)).status, 404, 'the client is not served from the game server');
    // Allowed origin connects; a foreign origin is refused (polling handshake carries the Origin header)
    const ok = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://ck.netlify.app' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://ck.netlify.app');
    const bad = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://evil.example' } });
    assert.notEqual(bad.status, 200);
    const local = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'http://localhost:5173' } });
    assert.notEqual(local.status, 200, 'production: localhost is not allowed unless listed');
  } finally {
    await srv.close();
  }
  // Without STATS_KEY the stats endpoint doesn't exist; in dev localhost is allowed
  const dev = await createGameServer({ port: 0, log: false, env: {} });
  try {
    assert.equal((await fetch(`http://localhost:${dev.port}/stats`)).status, 404);
    const local = await fetch(`http://localhost:${dev.port}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(local.status, 200);
  } finally {
    await dev.close();
  }
});
