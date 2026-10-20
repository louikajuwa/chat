const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, adminLogin, emitAck, waitFor, newRoom, sleep } = require('../helpers');

let ctx;
let cookie;
test.before(async () => {
  ctx = await startServer();
  ({ cookie } = await adminLogin(ctx.url));
});
test.after(async () => { await ctx.close(); });

const guest = async (name = 'Guest', room = newRoom()) => {
  const s = await ctx.connect();
  const ack = await emitAck(s, 'guestConnected', { guestName: name, room });
  assert.equal(ack.ok, true);
  return { s, room, token: ack.token };
};
const admin = async () => {
  const s = await ctx.connect({ cookie });
  assert.equal((await emitAck(s, 'adminConnected')).ok, true);
  return s;
};

test('admin events without cookie are unauthorized', async () => {
  const s = await ctx.connect();
  const { room } = await guest('G');
  const calls = [
    ['adminConnected', undefined],
    ['adminLoadMoreRooms', { beforeId: 5 }],
    ['adminSelectRoom', { room }],
    ['adminLoadMoreMessages', { room, beforeId: 5 }],
    ['adminMessage', { room, message: 'hi' }],
  ];
  for (const [ev, payload] of calls) {
    const un = waitFor(s, 'unauthorized');
    const ack = await emitAck(s, ev, payload);
    assert.deepEqual(ack, { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, ev);
    await un;
  }
});

test('admin events with tampered cookie are unauthorized', async () => {
  const s = await ctx.connect({ cookie: `admin_session=${Date.now() + 99999}.${'0'.repeat(64)}` });
  const ack = await emitAck(s, 'adminConnected');
  assert.equal(ack.code, 'UNAUTHORIZED');
});

test('unauthorized without ack emits unauthorized only', async () => {
  const s = await ctx.connect();
  const un = waitFor(s, 'unauthorized');
  s.emit('adminConnected');
  await un;
});

test('guest with bad room format is rejected', async () => {
  const s = await ctx.connect();
  for (const room of ['admins', 'room-1', '', null, 'room-be34a7d2-089d-4880-ad64-d07b8f3aff99; DROP', 42]) {
    const ack = await emitAck(s, 'guestConnected', { guestName: 'G', room });
    assert.deepEqual(ack, { ok: false, error: 'Invalid room' });
  }
  const ack = await emitAck(s, 'guestMessage', { message: 'hi' });
  assert.deepEqual(ack, { ok: false, error: 'Not in a room' });
});

test('guest name Admin is rejected case-insensitively', async () => {
  const s = await ctx.connect();
  for (const name of ['Admin', 'ADMIN', ' admin ']) {
    const ack = await emitAck(s, 'guestConnected', { guestName: name, room: newRoom() });
    assert.deepEqual(ack, { ok: false, error: 'That name is reserved' });
  }
  const bad = await emitAck(s, 'guestConnected', { guestName: 'x'.repeat(81), room: newRoom() });
  assert.equal(bad.ok, false);
});

test('errors without ack use serverError and never leak internals', async () => {
  const s = await ctx.connect();
  const err = waitFor(s, 'serverError');
  s.emit('guestConnected', { guestName: 'admin', room: newRoom() });
  assert.deepEqual(await err, { message: 'That name is reserved' });
});

test('guest cannot read or post to another room; client-supplied room is ignored', async () => {
  const a = await guest('Alice');
  const b = await guest('Bob');
  const seenByB = [];
  b.s.on('message', (m) => seenByB.push(m));

  const ack = await emitAck(a.s, 'guestMessage', { message: 'for A only', room: b.room, guestName: 'Admin' });
  assert.equal(ack.ok, true);
  await sleep(200);
  assert.equal(seenByB.length, 0);

  const [rows] = await ctx.pool.query('SELECT room, sender_name FROM messages WHERE message = ?', ['for A only']);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ room: a.room, sender_name: 'Alice' }]);

  // history for A never contains B's messages even if room param is supplied
  await emitAck(b.s, 'guestMessage', { message: 'secret B' });
  const hist = waitFor(a.s, 'chatHistoryAppend');
  await emitAck(a.s, 'guestLoadMoreMessages', { room: b.room, beforeId: 999999 });
  const h = await hist;
  assert.equal(h.room, a.room);
  assert.ok(h.messages.every((m) => m.room === a.room));
});

test('guest switching rooms leaves the previous room', async () => {
  const a = await guest('Alice');
  const other = await guest('Bob');
  const roomB = newRoom();
  await emitAck(a.s, 'guestConnected', { guestName: 'Alice', room: roomB });
  const got = [];
  a.s.on('message', (m) => got.push(m));
  await emitAck(other.s, 'guestMessage', { message: 'old room msg' });
  await sleep(200);
  assert.equal(got.length, 0);
});

test('message flows guest <-> admin with from_admin flag', async () => {
  const g = await guest('Carol');
  const ad = await admin();
  const hist = waitFor(ad, 'chatHistory');
  assert.equal((await emitAck(ad, 'adminSelectRoom', { room: g.room })).ok, true);
  assert.equal((await hist).room, g.room);

  const adminGets = waitFor(ad, 'message', (m) => m.message === 'hello admin');
  assert.equal((await emitAck(g.s, 'guestMessage', { message: '  hello admin  ' })).ok, true);
  const m1 = await adminGets;
  assert.equal(m1.from_admin, false);
  assert.equal(m1.sender_name, 'Carol');
  assert.equal(typeof m1.id, 'number');

  const guestGets = waitFor(g.s, 'message', (m) => m.message === 'hello guest');
  assert.equal((await emitAck(ad, 'adminMessage', { room: g.room, message: 'hello guest' })).ok, true);
  const m2 = await guestGets;
  assert.equal(m2.from_admin, true);
  assert.equal(m2.sender_name, 'Admin');
});

test('adminMessage to nonexistent room is rejected and inserts nothing', async () => {
  const ad = await admin();
  const room = newRoom();
  const ack = await emitAck(ad, 'adminMessage', { room, message: 'ghost' });
  assert.deepEqual(ack, { ok: false, error: 'Room not found' });
  const [rows] = await ctx.pool.query('SELECT 1 FROM messages WHERE room = ?', [room]);
  assert.equal(rows.length, 0);
  assert.equal((await emitAck(ad, 'adminSelectRoom', { room })).ok, false);
  assert.equal((await emitAck(ad, 'adminLoadMoreMessages', { room, beforeId: 5 })).ok, false);
});

test('admin accepts legacy (non-uuid) room names that exist', async () => {
  const ad = await admin();
  await ctx.pool.query("INSERT INTO chat_room (room, sender_name) VALUES ('legacy room', 'Old')");
  assert.equal((await emitAck(ad, 'adminMessage', { room: 'legacy room', message: 'hi' })).ok, true);
});

test('messages over 5000 chars rejected, 5000 accepted', async () => {
  const g = await guest('Dave');
  const ack = await emitAck(g.s, 'guestMessage', { message: 'a'.repeat(5001) });
  assert.deepEqual(ack, { ok: false, error: 'Message too long (max 5000 characters)' });
  assert.equal((await emitAck(g.s, 'guestMessage', { message: 'a'.repeat(5000) })).ok, true);
  assert.equal((await emitAck(g.s, 'guestMessage', { message: '   ' })).ok, false);
  assert.equal((await emitAck(g.s, 'guestMessage', { message: { $ne: 1 } })).ok, false);
});

test('pagination via beforeId has no duplicates or gaps', async () => {
  const g = await guest('Eve');
  for (let i = 1; i <= 45; i++) {
    await ctx.pool.query(
      "INSERT INTO messages (sender_name, message, room, readMessage) VALUES ('Eve', ?, ?, 'yes')",
      [`m${i}`, g.room]
    );
  }
  const ad = await admin();
  const first = waitFor(ad, 'chatHistory');
  await emitAck(ad, 'adminSelectRoom', { room: g.room });
  let page = await first;
  assert.equal(page.messages.length, 20);
  assert.equal(page.hasMore, true);
  let all = [...page.messages];

  // a new message arriving mid-pagination must not shift pages
  await emitAck(g.s, 'guestMessage', { message: 'late' });

  while (page.hasMore) {
    const next = waitFor(ad, 'chatHistoryAppend');
    await emitAck(ad, 'adminLoadMoreMessages', { room: g.room, beforeId: all[0].id });
    page = await next;
    all = [...page.messages, ...all];
  }
  const texts = all.map((m) => m.message);
  assert.deepEqual(texts, Array.from({ length: 45 }, (_, i) => `m${i + 1}`));
  assert.equal(new Set(all.map((m) => m.id)).size, 45);
  assert.deepEqual(all.map((m) => m.id), [...all.map((m) => m.id)].sort((x, y) => x - y));

  // guest side pagination
  const gh = waitFor(g.s, 'chatHistoryAppend');
  await emitAck(g.s, 'guestLoadMoreMessages', { beforeId: all[30].id });
  assert.equal((await gh).messages.length, 20);
  for (const bad of [0, -1, 'x', 1.5, null, undefined]) {
    assert.equal((await emitAck(g.s, 'guestLoadMoreMessages', { beforeId: bad })).ok, false);
  }
});

test('read status: unread until an admin selects the room', async () => {
  const g = await guest('Frank');
  await emitAck(g.s, 'guestMessage', { message: 'anyone?' });

  const a1 = await admin();
  const list = await new Promise((resolve) => {
    a1.once('roomList', resolve);
    a1.emit('adminConnected');
  });
  const row = list.rooms.find((r) => r.room === g.room);
  assert.equal(row.has_unread, true);
  assert.deepEqual(Object.keys(row).sort(),
    ['created', 'has_unread', 'id', 'last_at', 'last_attachment', 'last_message', 'room', 'sender_name'].sort());
  assert.equal(row.last_message, 'anyone?');

  const upd = waitFor(a1, 'roomUpdate', (m) => m.room === g.room);
  await emitAck(a1, 'adminSelectRoom', { room: g.room });
  assert.equal((await upd).has_unread, false);

  // messages while an admin is viewing are read immediately
  await emitAck(g.s, 'guestMessage', { message: 'still here' });
  const a2 = await admin();
  const list2 = await new Promise((resolve) => {
    a2.once('roomList', resolve);
    a2.emit('adminConnected');
  });
  assert.equal(list2.rooms.find((r) => r.room === g.room).has_unread, false);

  // after the admin disconnects, new messages are unread again
  a1.close();
  await sleep(200);
  await emitAck(g.s, 'guestMessage', { message: 'hello?' });
  const a3 = await admin();
  const list3 = await new Promise((resolve) => {
    a3.once('roomList', resolve);
    a3.emit('adminConnected');
  });
  assert.equal(list3.rooms.find((r) => r.room === g.room).has_unread, true);
});

test('roomNew is broadcast to admins on first connect, roomUpdate afterwards', async () => {
  const ad = await admin();
  const room = newRoom();
  const created = waitFor(ad, 'roomNew', (m) => m.room === room);
  const g = await guest('Gina', room);
  assert.equal((await created).sender_name, 'Gina');
  const upd = waitFor(ad, 'roomUpdate', (m) => m.room === room);
  const s2 = await ctx.connect();
  await emitAck(s2, 'guestConnected', { guestName: 'Gina', room, token: g.token });
  await upd;
});

test('per-socket message rate limit: 10 per 10s', async () => {
  const g = await guest('Hank');
  const results = [];
  for (let i = 0; i < 12; i++) results.push(await emitAck(g.s, 'guestMessage', { message: `spam ${i}` }));
  assert.equal(results.filter((r) => r.ok).length, 10);
  assert.deepEqual(results[10], { ok: false, error: 'Too many requests, slow down' });
});

test('non-message events are limited to 30 per 10s', async () => {
  const g = await guest('Ivy');
  const results = [];
  for (let i = 0; i < 32; i++) results.push(await emitAck(g.s, 'guestLoadMoreMessages', { beforeId: 1 }));
  assert.equal(results.filter((r) => r.ok).length, 29); // guestConnected used one
  assert.equal(results[31].error, 'Too many requests, slow down');
});

test('malformed payloads do not crash the server', async () => {
  const s = await ctx.connect({ cookie });
  for (const p of [null, 'str', 5, [], undefined]) {
    for (const ev of ['guestConnected', 'guestMessage', 'adminSelectRoom', 'adminMessage', 'adminLoadMoreRooms']) {
      const ack = await emitAck(s, ev, p);
      if (ev === 'adminLoadMoreRooms') assert.equal(ack.ok, true);
      else assert.equal(ack.ok, false);
    }
  }
  const res = await fetch(ctx.url + '/healthz');
  assert.equal(res.status, 200);
});

test('admin socket loses privileges when its session expires mid-connection', async () => {
  const { sign, sha256hex } = require('../../src/auth');
  const sid = 'c'.repeat(32);
  const exp = Date.now() + 400;
  await ctx.pool.query('INSERT INTO admin_sessions (sid_hash, expires_at) VALUES (?, ?)', [sha256hex(sid), exp]);
  const shortCookie = `admin_session=${sign('test-secret', exp, sid)}`;
  const s = await ctx.connect({ cookie: shortCookie });
  assert.equal((await emitAck(s, 'adminConnected')).ok, true);
  await waitFor(s, 'unauthorized', () => true, 2000);
  const { room, token } = await guest('Late');
  let leaked = false;
  s.on('roomUpdate', () => { leaked = true; });
  s.on('roomNew', () => { leaked = true; });
  const g = await ctx.connect();
  await emitAck(g, 'guestConnected', { guestName: 'Late2', room, token });
  await sleep(150);
  assert.equal(leaked, false, 'expired admin still receives sidebar broadcasts');
  assert.equal((await emitAck(s, 'adminConnected')).code, 'UNAUTHORIZED');
});

test('logout revokes the session: copied cookie is rejected and live sockets lose admin', async () => {
  const { cookie: c } = await adminLogin(ctx.url);
  const s = await ctx.connect({ cookie: c });
  assert.equal((await emitAck(s, 'adminConnected')).ok, true);
  const kicked = waitFor(s, 'unauthorized', () => true, 2000);
  const out = await fetch(`${ctx.url}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: c } });
  assert.equal(out.status, 303);
  await kicked;
  assert.equal((await emitAck(s, 'adminConnected')).code, 'UNAUTHORIZED');
  // The same cookie value, replayed after logout, no longer opens the admin page or socket.
  const page = await fetch(`${ctx.url}/admin.html`, { redirect: 'manual', headers: { Cookie: c } });
  assert.equal(page.status, 302);
  const replay = await ctx.connect({ cookie: c });
  assert.equal((await emitAck(replay, 'adminConnected')).code, 'UNAUTHORIZED');
});
