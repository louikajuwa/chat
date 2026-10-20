const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../../src/validate');

const ROOM = 'room-be34a7d2-089d-4880-ad64-d07b8f3aff99';

test('guestRoom accepts strict format and trims', () => {
  assert.equal(v.guestRoom(`  ${ROOM} `), ROOM);
  assert.equal(v.guestRoom(ROOM.toUpperCase().replace('ROOM', 'room')), ROOM.toUpperCase().replace('ROOM', 'room'));
});

test('guestRoom rejects bad input', () => {
  for (const bad of ['', 'admins', 'room-1', ROOM + 'x', 'x' + ROOM, null, undefined, 5, {}, [ROOM]]) {
    assert.throws(() => v.guestRoom(bad), v.ValidationError);
  }
});

test('adminRoom accepts legacy strings up to 250 chars', () => {
  assert.equal(v.adminRoom(' legacy '), 'legacy');
  assert.equal(v.adminRoom('a'.repeat(250)).length, 250);
  assert.throws(() => v.adminRoom('a'.repeat(251)), v.ValidationError);
  assert.throws(() => v.adminRoom('   '), v.ValidationError);
  assert.throws(() => v.adminRoom(42), v.ValidationError);
});

test('guestName', () => {
  assert.equal(v.guestName('  Bob '), 'Bob');
  assert.equal(v.guestName('a'.repeat(80)).length, 80);
  assert.throws(() => v.guestName('a'.repeat(81)), v.ValidationError);
  assert.throws(() => v.guestName(''), v.ValidationError);
  assert.throws(() => v.guestName(null), v.ValidationError);
  for (const n of ['admin', 'ADMIN', ' Admin ']) {
    assert.throws(() => v.guestName(n), /That name is reserved/);
  }
  assert.equal(v.guestName('Administrator'), 'Administrator');
});

test('message', () => {
  assert.equal(v.message('  hi '), 'hi');
  assert.equal(v.message(undefined), '');
  assert.equal(v.message('a'.repeat(5000)).length, 5000);
  assert.throws(() => v.message('a'.repeat(5001)), /Message too long \(max 5000 characters\)/);
  assert.throws(() => v.message(123), v.ValidationError);
  assert.throws(() => v.message({}), v.ValidationError);
});

test('beforeId', () => {
  assert.equal(v.beforeId(5), 5);
  assert.equal(v.beforeId('12'), 12);
  assert.equal(v.beforeId(undefined), null);
  for (const bad of [0, -1, 1.5, 'abc', '1; DROP', NaN, Infinity, {}, [], true, 2 ** 60]) {
    assert.throws(() => v.beforeId(bad), v.ValidationError);
  }
  assert.throws(() => v.beforeId(undefined, { required: true }), v.ValidationError);
});

test('payload coerces non-objects to {}', () => {
  assert.deepEqual(v.payload(null), {});
  assert.deepEqual(v.payload('x'), {});
  assert.deepEqual(v.payload([1]), {});
  assert.deepEqual(v.payload({ a: 1 }), { a: 1 });
});
