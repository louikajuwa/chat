const { test, expect, startGuestChat, sendText } = require('./fixtures');

test('reload resumes the conversation with history intact', async ({ page }) => {
  const { name } = await startGuestChat(page);
  await sendText(page, 'one');
  await sendText(page, 'two');
  await page.reload();
  await expect(page.locator('#chat')).toBeVisible();
  await expect(page.locator('#me-name')).toHaveText(name);
  await expect(page.locator('#messages > div')).toHaveCount(2);
  await expect(page.locator('#messages')).toContainText('one');
  await expect(page.locator('#messages')).toContainText('two');
});

test('tampered guestToken shows onboarding again', async ({ page }) => {
  await startGuestChat(page);
  await page.evaluate(() => localStorage.setItem('guestToken', 'f'.repeat(64)));
  await page.reload();
  await expect(page.locator('#onboard')).toBeVisible();
  await expect(page.locator('#chat')).toBeHidden();
  await expect(page.locator('#name-error')).toContainText(/no longer available/i);
  expect(await page.evaluate(() => localStorage.getItem('guestToken'))).toBeNull();
});
