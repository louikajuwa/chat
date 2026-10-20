const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connectClient, emitAck, newRoom, sleep } = require('../helpers');

test('per-IP connection cap rejects excess sockets and frees slots on close', async () => {
  const ctx = await startServer({ MAX_SOCKETS_PER_IP: 3 });
  try {
    const open = [];
    for (let i = 0; i < 3; i++) open.push(await ctx.connect());
    await assert.rejects(ctx.connect(), (err) => err.message === 'Too many connections');
    open[0].close();
    let again = null;
    for (let i = 0; i < 20 && !again; i++) {
      await sleep(50);
      again = await ctx.connect().catch(() => null);
    }
    assert.ok(again, 'slot was not released after disconnect');
  } finally {
    await ctx.close();
  }
});

test('connection counters do not leak across connect/disconnect rounds', async () => {
  const ctx = await startServer({ MAX_SOCKETS_PER_IP: 2 });
  try {
    for (let round = 0; round < 4; round++) {
      const a = connectClient(ctx.url);
      const b = connectClient(ctx.url);
      await Promise.all([a.ready, b.ready]);
      a.close();
      b.close();
      await sleep(150);
    }
  } finally {
    await ctx.close();
  }
});

test('per-IP new-room limit applies to creation only, not to resuming', async () => {
  const ctx = await startServer({ ROOMS_PER_IP: 2 });
  try {
    const a = await ctx.connect();
    const r1 = await emitAck(a, 'guestConnected', { guestName: 'A', room: newRoom() });
    const room2 = newRoom();
    const r2 = await emitAck(a, 'guestConnected', { guestName: 'A', room: room2 });
    assert.equal(r1.ok && r2.ok, true);
    const r3 = await emitAck(a, 'guestConnected', { guestName: 'A', room: newRoom() });
    assert.deepEqual(r3, { ok: false, error: 'Too many new chats, try again later' });
    // Resuming an existing room still works while the creation limit is exhausted.
    const b = await ctx.connect();
    const resume = await emitAck(b, 'guestConnected', { guestName: 'A', room: room2, token: r2.token });
    assert.deepEqual(resume, { ok: true });
    // The rejected creation left no room behind.
    const [rows] = await ctx.pool.query('SELECT COUNT(*) AS n FROM chat_room');
    assert.equal(rows[0].n, 2);
  } finally {
    await ctx.close();
  }
});

test('aggregate per-IP message limit spans sockets', async () => {
  const ctx = await startServer({ MESSAGES_PER_IP: 5 });
  try {
    const socks = [];
    for (let i = 0; i < 3; i++) {
      const s = await ctx.connect();
      await emitAck(s, 'guestConnected', { guestName: `G${i}`, room: newRoom() });
      socks.push(s);
    }
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await emitAck(socks[i % 3], 'guestMessage', { message: `m${i}` }));
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.deepEqual(results[7], { ok: false, error: 'Too many requests, slow down' });
  } finally {
    await ctx.close();
  }
});
