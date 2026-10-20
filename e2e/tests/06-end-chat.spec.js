const { test, expect, startGuestChat, sendText } = require('./fixtures');

test('End chat: dismissing keeps the chat, accepting returns to onboarding', async ({ page }) => {
  await startGuestChat(page);
  await sendText(page, 'keep me');

  let seen = '';
  page.once('dialog', (d) => { seen = d.message(); d.dismiss(); });
  await page.locator('#quit-btn').click();
  await expect.poll(() => seen).toMatch(/End this chat/);
  await expect(page.locator('#chat')).toBeVisible();
  await expect(page.locator('#messages')).toContainText('keep me');

  page.once('dialog', (d) => d.accept());
  await page.locator('#quit-btn').click();
  await expect(page.locator('#onboard')).toBeVisible();
  await expect(page.locator('#chat')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('room'))).toBeNull();
});
