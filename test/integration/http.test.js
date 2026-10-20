const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, adminLogin, ADMIN_PASSWORD } = require('../helpers');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(async () => { await ctx.close(); });

const get = (p, headers = {}) => fetch(ctx.url + p, { redirect: 'manual', headers });

test('healthz returns 200 ok', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('healthz returns 503 when DB is down', async () => {
  const bad = await startServer();
  await bad.pool.end();
  const res = await fetch(bad.url + '/healthz');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: 'error' });
  await bad.io.close();
});

test('security headers present on all responses', async () => {
  for (const p of ['/healthz', '/login.html', '/guest.html']) {
    const res = await get(p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', p);
    assert.equal(res.headers.get('x-powered-by'), null, p);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' https:\/\/cdn\.tailwindcss\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
  }
});

test('/admin.html and /admin without cookie redirect to login', async () => {
  for (const p of ['/admin.html', '/admin', '/admin/', '/ADMIN.HTML', '/%61dmin.html', '/./admin.html', '/x/../admin.html']) {
    const res = await get(p);
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get('location'), '/login.html', p);
  }
});

test('/admin.html with forged or tampered cookie redirects', async () => {
  const res = await get('/admin.html', { Cookie: `admin_session=${Date.now() + 99999}.${'a'.repeat(64)}` });
  assert.equal(res.status, 302);
});

test('/admin.html with valid cookie serves page, no-store', async () => {
  const { cookie } = await adminLogin(ctx.url);
  for (const p of ['/admin.html', '/admin', '/%61dmin.html']) {
    const res = await get(p, { Cookie: cookie });
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
});

test('login success sets hardened cookie and redirects (urlencoded and json)', async () => {
  const { res, cookie } = await adminLogin(ctx.url);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin.html');
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /^admin_session=\d+\.[0-9a-f]{32}\.[0-9a-f]{64};/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Max-Age=43200/);
  assert.doesNotMatch(sc, /Secure/);
  assert.ok(cookie);

  const j = await fetch(ctx.url + '/admin/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(j.status, 200);
  assert.deepEqual(await j.json(), { ok: true });
});

test('login with wrong password redirects with error=invalid and sets no cookie', async () => {
  const { res, cookie } = await adminLogin(ctx.url, 'nope');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login.html?error=invalid');
  assert.equal(cookie, null);
});

test('login with missing or non-string password fails', async () => {
  for (const [ct, body] of [
    ['application/json', '{}'],
    ['application/json', JSON.stringify({ password: ['test-pass'] })],
    ['application/x-www-form-urlencoded', ''],
    ['text/plain', 'password=test-pass'],
  ]) {
    const res = await fetch(ctx.url + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': ct }, body });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login.html?error=invalid');
  }
});

test('oversized login body is rejected', async () => {
  const res = await fetch(ctx.url + '/admin/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + 'a'.repeat(20000),
  });
  assert.equal(res.status, 413);
});

test('logout clears cookie and redirects', async () => {
  const res = await fetch(ctx.url + '/admin/logout', { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login.html');
  assert.match(res.headers.get('set-cookie'), /^admin_session=; .*Max-Age=0/);
});

test('rate limit: 6th login attempt in a minute is limited', async () => {
  const limited = await startServer({ LOGIN_MAX_ATTEMPTS: 5 });
  try {
    for (let i = 0; i < 5; i++) {
      const { res } = await adminLogin(limited.url, 'wrong');
      assert.equal(res.headers.get('location'), '/login.html?error=invalid');
    }
    const { res, cookie } = await adminLogin(limited.url, ADMIN_PASSWORD);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login.html?error=rate');
    assert.equal(cookie, null);
    const j = await fetch(limited.url + '/admin/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    assert.equal(j.status, 429);
  } finally {
    await limited.close();
  }
});

test('admin disabled when ADMIN_PASSWORD is empty (fail closed)', async () => {
  const off = await startServer({ ADMIN_PASSWORD: '' });
  try {
    for (const pw of ['', 'test-pass', 'undefined']) {
      const { res, cookie } = await adminLogin(off.url, pw);
      assert.equal(res.headers.get('location'), '/login.html?error=invalid');
      assert.equal(cookie, null);
    }
  } finally {
    await off.close();
  }
});
