const { test, expect, startGuestChat, sendText, openRoom, ensureInboxVisible } = require('./fixtures');

test('guest <-> admin realtime exchange', async ({ newGuestPage, newAdminPage }) => {
  const admin = await newAdminPage();
  await admin.goto('/admin.html');
  await expect(admin.locator('#room-list-container')).toBeAttached();

  const guest = await newGuestPage();
  const { name, room } = await startGuestChat(guest);
  await sendText(guest, 'first message');

  // Admin sees the new room with an unread marker, without reloading.
  await ensureInboxVisible(admin);
  const card = admin.locator(`#room-list button[data-room="${room}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(name);
  await expect(card.getByText('Unread')).toBeAttached();

  // Open it: history shown, unread cleared.
  await openRoom(admin, room);
  await expect(admin.locator('#messages')).toContainText('first message');
  await ensureInboxVisible(admin);
  await expect(card.getByText('Unread')).toHaveCount(0);
  if (await admin.locator('#drawer-close').isVisible()) await admin.locator('#drawer-close').click();

  // Admin replies, guest receives it live.
  await admin.locator('#message-input').fill('reply from admin');
  await expect(admin.locator('#send-btn')).toBeEnabled();
  await admin.locator('#send-btn').click();
  await expect(admin.locator('#messages')).toContainText('reply from admin');
  await expect(guest.locator('#messages')).toContainText('reply from admin');

  // Guest writes while admin is viewing: appears live in the admin pane.
  await sendText(guest, 'second guest message');
  await expect(admin.locator('#messages')).toContainText('second guest message');
});
