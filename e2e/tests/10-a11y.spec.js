const { test, expect, startGuestChat, openRoom } = require('./fixtures');

test('guest: message list is role=log; toasts are status/alert', async ({ page }) => {
  await startGuestChat(page);
  await expect(page.getByRole('log')).toHaveAttribute('id', 'messages');
  // Trigger a toast through the real UI (rejected oversized file).
  await page.locator('#file-input').setInputFiles({
    name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
  });
  await expect(page.locator('#toast-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#toast')).toHaveAttribute('role', 'status');
  await expect(page.locator('#conn-banner')).toHaveAttribute('role', 'status');
});

test('admin: message list is role=log', async ({ newAdminPage, newGuestPage }) => {
  const admin = await newAdminPage();
  await admin.goto('/admin.html');
  const guest = await newGuestPage();
  const { room } = await startGuestChat(guest);
  await guest.locator('#message-input').fill('hi');
  await guest.locator('#send-btn').click();
  await openRoom(admin, room);
  await expect(admin.locator('[role=log]#messages')).toHaveCount(1);
  await expect(admin.locator('#messages')).toContainText('hi');
});
