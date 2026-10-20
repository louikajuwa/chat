const { test, expect, pngBuffer, startGuestChat, sendText } = require('./fixtures');

test('reserved name "admin" is rejected', async ({ page }) => {
  await page.goto('/guest.html');
  await page.locator('#name').fill('Admin');
  await page.locator('#onboard-form button[type=submit]').click();
  await expect(page.locator('#name-error')).toBeVisible();
  await expect(page.locator('#name-error')).toContainText(/reserved/i);
  await expect(page.locator('#chat')).toBeHidden();
});

test('guest can start a chat and send text', async ({ page }) => {
  const { name } = await startGuestChat(page);
  await expect(page.locator('#me-name')).toHaveText(name);
  await sendText(page, `hello from ${name}`);
  await expect(page.locator('#messages > div')).toHaveCount(1);
});

test('guest can attach a small PNG and it renders', async ({ page }) => {
  await startGuestChat(page);
  await page.locator('#file-input').setInputFiles({
    name: 'pixel.png', mimeType: 'image/png', buffer: pngBuffer(24, 24),
  });
  await expect(page.locator('#file-chip-name')).toHaveText('pixel.png');
  await expect(page.locator('#send-btn')).toBeEnabled();
  await page.locator('#send-btn').click();
  const img = page.locator('#messages img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBe(24);
});

test('oversized file is rejected client-side and nothing is sent', async ({ page }) => {
  await startGuestChat(page);
  await page.locator('#file-input').setInputFiles({
    name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
  });
  await expect(page.locator('#toast-error')).toContainText(/too large/i);
  await expect(page.locator('#file-chip')).toBeHidden();
  await expect(page.locator('#send-btn')).toBeDisabled();
  await expect(page.locator('#messages > div')).toHaveCount(0);
});
