const { test, expect, watchErrors } = require('./fixtures');

for (const path of ['/', '/guest.html', '/login.html', '/admin.html']) {
  test(`no console errors or CSP violations on ${path}`, async ({ page, newAdminPage }) => {
    const p = path === '/admin.html' ? await newAdminPage() : page;
    const errors = watchErrors(p);
    await p.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const res = await p.goto(path);
    expect(res.status()).toBe(200);
    await p.waitForLoadState('networkidle');
    if (path === '/admin.html') await expect(p.locator('#room-list-container')).toBeAttached();
    expect(await p.evaluate(() => window.__csp)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
