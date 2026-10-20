const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, emitAck, newRoom } = require('../helpers');
const { makeRepo } = require('../../src/db');
const { ValidationError } = require('../../src/validate');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(async () => { await ctx.close(); });

const join = async (room, token, name = 'Tok') => {
  const s = await ctx.connect();
  const payload = { guestName: name, room };
  if (token !== undefined) payload.token = token;
  const ack = await emitAck(s, 'guestConnected', payload);
  return { s, ack };
};
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

test('new room returns a 64-hex token and stores only its hash', async () => {
  const room = newRoom();
  const { ack } = await join(room);
  assert.equal(ack.ok, true);
  assert.match(ack.token, /^[0-9a-f]{64}$/);
  const [[row]] = await ctx.pool.query('SELECT guest_token_hash FROM chat_room WHERE room = ?', [room]);
  assert.equal(row.guest_token_hash, sha(ack.token));
});

test('resume with the right token succeeds and issues no new token', async () => {
  const room = newRoom();
  const first = (await join(room)).ack;
  const { ack } = await join(room, first.token);
  assert.deepEqual(ack, { ok: true });
});

test('client-generated token: stored on creation, not echoed, and a retried join still matches', async () => {
  const room = newRoom();
  const own = crypto.randomBytes(32).toString('hex');
  assert.deepEqual((await join(room, own)).ack, { ok: true });
  const [[row]] = await ctx.pool.query('SELECT guest_token_hash FROM chat_room WHERE room = ?', [room]);
  assert.equal(row.guest_token_hash, sha(own));
  // Simulates a retry after the first ack was lost.
  assert.deepEqual((await join(room, own)).ack, { ok: true });
  assert.deepEqual((await join(room, crypto.randomBytes(32).toString('hex'))).ack, { ok: false, error: 'Invalid room' });
});

test('legacy room claimed with a client-generated token', async () => {
  const room = newRoom();
  await ctx.pool.query('INSERT INTO chat_room (room, sender_name) VALUES (?, ?)', [room, 'Old']);
  const own = crypto.randomBytes(32).toString('hex');
  assert.deepEqual((await join(room, own)).ack, { ok: true });
  assert.deepEqual((await join(room, own)).ack, { ok: true });
  assert.deepEqual((await join(room)).ack, { ok: false, error: 'Invalid room' });
});

test('wrong, missing, malformed and non-string tokens are rejected as Invalid room', async () => {
  const room = newRoom();
  const { token } = (await join(room)).ack;
  const wrong = crypto.randomBytes(32).toString('hex');
  for (const bad of [undefined, wrong, token.toUpperCase(), 'short', '', 42, null, { a: 1 }, [token]]) {
    const { ack } = await join(room, bad);
    assert.deepEqual(ack, { ok: false, error: 'Invalid room' }, JSON.stringify(bad));
  }
});

test('rejected join does not put the socket in the room', async () => {
  const room = newRoom();
  await join(room);
  const { s, ack } = await join(room, undefined);
  assert.equal(ack.ok, false);
  assert.deepEqual(await emitAck(s, 'guestMessage', { message: 'hi' }), { ok: false, error: 'Not in a room' });
});

test('legacy room (NULL hash) is claimed once; a second claimant without the token is rejected', async () => {
  const room = newRoom();
  await ctx.pool.query('INSERT INTO chat_room (room, sender_name) VALUES (?, ?)', [room, 'Old']);
  const first = (await join(room)).ack;
  assert.equal(first.ok, true);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  const second = (await join(room)).ack;
  assert.deepEqual(second, { ok: false, error: 'Invalid room' });
  assert.deepEqual((await join(room, first.token)).ack, { ok: true });
});

test('concurrent claimants of a legacy room: exactly one wins', async () => {
  const room = newRoom();
  await ctx.pool.query('INSERT INTO chat_room (room, sender_name) VALUES (?, ?)', [room, 'Old']);
  const results = await Promise.all([join(room), join(room), join(room), join(room)]);
  assert.equal(results.filter((r) => r.ack.ok).length, 1);
});

test('FK: repo.insertMessage for a nonexistent room is a ValidationError', async () => {
  const repo = makeRepo(ctx.pool, ctx.config);
  await assert.rejects(
    repo.insertMessage({ sender: 'x', message: 'hi', room: newRoom(), readStatus: 'no' }),
    (err) => err instanceof ValidationError && err.message === 'Room not found'
  );
});
