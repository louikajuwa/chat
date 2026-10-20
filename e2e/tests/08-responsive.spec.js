const { test, expect, startGuestChat, sendText, openRoom, isMobile } = require('./fixtures');

async function expectNoOverflow(page) {
  const { sw, iw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth,
  }));
  expect(sw, `scrollWidth ${sw} > innerWidth ${iw}`).toBeLessThanOrEqual(iw);
}

test('guest: no horizontal overflow, composer within viewport', async ({ page }) => {
  await page.goto('/guest.html');
  await expectNoOverflow(page);
  await startGuestChat(page);
  await sendText(page, 'a'.repeat(300)); // long unbroken text must not widen the page
  await expectNoOverflow(page);
  await expect(page.locator('#chat-form')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#send-btn')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#message-input')).toBeInViewport({ ratio: 1 });
});

test('login: no horizontal overflow', async ({ page }) => {
  await page.goto('/login.html');
  await expectNoOverflow(page);
});

test('admin: no horizontal overflow, composer within viewport', async ({ newAdminPage, newGuestPage }) => {
  const admin = await newAdminPage();
  await admin.goto('/admin.html');
  await expect(admin.locator('#room-list-container')).toBeAttached();
  await expectNoOverflow(admin);
  const guest = await newGuestPage();
  const { room } = await startGuestChat(guest);
  await sendText(guest, 'b'.repeat(300));
  await openRoom(admin, room);
  await expect(admin.locator('#messages')).toContainText('bbbb');
  await expectNoOverflow(admin);
  await expect(admin.locator('#chat-form')).toBeInViewport({ ratio: 1 });
  await expect(admin.locator('#send-btn')).toBeInViewport({ ratio: 1 });
});

test('admin drawer (mobile): toggle opens/closes, Escape closes and restores focus', async ({ newAdminPage }) => {
  const admin = await newAdminPage();
  test.skip(!isMobile(admin), 'drawer only exists below 768px');
  await admin.goto('/admin.html');
  const toggle = admin.locator('#drawer-toggle');
  const drawer = admin.locator('#drawer');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer).toHaveClass(/\bopen\b/);
  await expect(admin.locator('#drawer-close')).toBeFocused();

  await admin.locator('#drawer-close').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer).not.toHaveClass(/\bopen\b/);

  await toggle.click();
  await expect(drawer).toHaveClass(/\bopen\b/);
  await admin.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer).not.toHaveClass(/\bopen\b/);
  await expect(toggle).toBeFocused();
});
