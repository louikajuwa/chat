const { test, expect, ensureInboxVisible } = require('./fixtures');

// Logout revokes the session server-side, so this spec must use its own login:
// logging out the shared storageState session would sign out every other admin test.
test('logout returns to /login.html, revokes the session, and /admin.html redirects again', async ({ browser, baseURL, viewport }) => {
  const ctx = await browser.newContext({ baseURL, viewport });
  const admin = await ctx.newPage();
  try {
    await admin.goto('/login.html');
    await admin.locator('input[name=password]').fill(process.env.ADMIN_PASSWORD);
    await admin.locator('input[name=password]').press('Enter');
    await expect(admin).toHaveURL(/\/admin\.html$/);
    const [session] = (await ctx.cookies()).filter((c) => c.name === 'admin_session');
    expect(session).toBeTruthy();

    await ensureInboxVisible(admin); // the Log out button lives in the (mobile) drawer
    await admin.getByRole('button', { name: 'Log out' }).click();
    await expect(admin).toHaveURL(/\/login\.html$/);
    await admin.goto('/admin.html');
    await expect(admin).toHaveURL(/\/login\.html$/);

    // Replaying the old cookie value (e.g. a copied cookie) must not work after logout.
    await ctx.addCookies([session]);
    await admin.goto('/admin.html');
    await expect(admin).toHaveURL(/\/login\.html$/);
  } finally {
    await ctx.close();
  }
});
