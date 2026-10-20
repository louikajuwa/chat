const test = require('node:test');
const assert = require('node:assert/strict');
const { sign, verify, parseCookies, createAuth, memoryStore } = require('../../src/auth');

const SECRET = 'unit-secret';
const SID = 'a'.repeat(32);

test('valid token verifies and returns exp + sid', () => {
  const exp = Date.now() + 60000;
  assert.deepEqual(verify(SECRET, sign(SECRET, exp, SID)), { exp, sid: SID });
});

test('tampered exp, sid or signature is rejected', () => {
  const exp = Date.now() + 60000;
  const [e, sid, sig] = sign(SECRET, exp, SID).split('.');
  assert.equal(verify(SECRET, `${Number(e) + 100000}.${sid}.${sig}`), null);
  assert.equal(verify(SECRET, `${e}.${'b'.repeat(32)}.${sig}`), null);
  const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  assert.equal(verify(SECRET, `${e}.${sid}.${flipped}`), null);
});

test('expired token is rejected', () => {
  assert.equal(verify(SECRET, sign(SECRET, Date.now() - 1, SID)), null);
  assert.deepEqual(verify(SECRET, sign(SECRET, 1000, SID), 999), { exp: 1000, sid: SID });
});

test('wrong secret is rejected', () => {
  assert.equal(verify('other', sign(SECRET, Date.now() + 60000, SID)), null);
});

test('malformed and legacy (sid-less) tokens are rejected', () => {
  const legacy = `${Date.now() + 9999}.${'0'.repeat(64)}`;
  for (const bad of [undefined, null, 5, '', '.', 'abc', '123.', '.abc', '123.zz', '123.abcd', legacy,
    `${Date.now() + 9999}.${SID}.${'g'.repeat(64)}`, 'a.b.c']) {
    assert.equal(verify(SECRET, bad), null);
  }
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world;  c="q"'), { a: '1', b: 'hello world', c: 'q' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('garbage'), {});
  assert.equal(parseCookies('a=1; a=2').a, '1');
  assert.equal(parseCookies('a=%E0%A4%A').a, '%E0%A4%A');
});

test('checkPassword fails closed without ADMIN_PASSWORD', () => {
  const closed = createAuth({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: '', SESSION_TTL_MS: 1000 });
  assert.equal(closed.checkPassword(''), false);
  assert.equal(closed.checkPassword('anything'), false);
  const open = createAuth({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'pw', SESSION_TTL_MS: 1000 });
  assert.equal(open.checkPassword('pw'), true);
  assert.equal(open.checkPassword('pw '), false);
  assert.equal(open.checkPassword(undefined), false);
  assert.equal(open.checkPassword(['pw']), false);
});

const captureCookie = async (auth) => {
  const headers = [];
  await auth.setCookie({ append: (k, val) => headers.push([k, val]) });
  return headers[0][1];
};

test('cookie flags', async () => {
  const c = await captureCookie(createAuth({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'pw', SESSION_TTL_MS: 5000, NODE_ENV: 'production' }));
  assert.match(c, /^admin_session=\d+\.[0-9a-f]{32}\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=5; Secure$/);
});

test('session is valid until revoked; revocation survives a valid signature', async () => {
  const auth = createAuth({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'pw', SESSION_TTL_MS: 60000 }, memoryStore());
  const cookie = (await captureCookie(auth)).split(';')[0];
  const s = await auth.session(cookie);
  assert.match(s.sid, /^[0-9a-f]{32}$/);
  assert.equal(await auth.revoke(cookie), s.sid);
  assert.equal(await auth.session(cookie), null);
  // A correctly signed token whose sid was never issued is rejected too.
  assert.equal(await auth.session(`admin_session=${sign(SECRET, Date.now() + 60000, SID)}`), null);
});
