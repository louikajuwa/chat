const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../../src/rateLimit');

test('allows up to limit then blocks within window', () => {
  const l = createLimiter({ limit: 3, windowMs: 1000 });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => l.hit('k', 0)), [true, true, true, false, false]);
});

test('keys are independent', () => {
  const l = createLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(l.hit('a', 0), true);
  assert.equal(l.hit('b', 0), true);
  assert.equal(l.hit('a', 0), false);
});

test('window resets', () => {
  const l = createLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(l.hit('a', 0), true);
  assert.equal(l.hit('a', 999), false);
  assert.equal(l.hit('a', 1000), true);
});

test('expired entries are pruned', () => {
  const l = createLimiter({ limit: 1, windowMs: 10 });
  for (let i = 0; i < 1500; i++) l.hit(`k${i}`, 0);
  l.hit('new', 100);
  assert.ok(l.size() < 10);
});
