const { test, expect } = require('./fixtures');

test('unauthenticated /admin.html redirects to /login.html', async ({ page }) => {
  await page.goto('/admin.html');
  await expect(page).toHaveURL(/\/login\.html$/);
  await expect(page.locator('#password')).toBeVisible();
});

// Budget: this is the ONLY wrong login in the whole run (limit is 5/min/IP, globalSetup uses 1).
test('wrong password shows "Incorrect password."', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1366', 'single wrong attempt per run');
  await page.goto('/login.html');
  await page.locator('#password').fill('definitely-not-the-password');
  await page.locator('form[action="/admin/login"] button[type=submit]').click();
  await expect(page).toHaveURL(/\/login\.html\?error=invalid$/);
  const err = page.locator('#login-error');
  await expect(err).toBeVisible();
  await expect(err).toHaveText('Incorrect password.');
});
