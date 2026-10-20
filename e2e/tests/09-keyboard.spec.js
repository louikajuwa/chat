const { test, expect, startGuestChat, sendText, openRoom } = require('./fixtures');

// Presses Tab until the file input is focused, then checks for a visible focus indicator.
async function tabToFileInput(page) {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(() => {
      const a = document.activeElement;
      return !!a && a.matches('input[type=file]');
    });
    if (hit) return;
  }
  throw new Error('Tab never reached input[type=file]');
}

async function expectVisibleFocus(page) {
  const s = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow };
  });
  const ok = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
  expect(ok, `no visible focus indicator: ${JSON.stringify(s)}`).toBe(true);
}

test('guest: Tab reaches the file input with a visible focus indicator', async ({ page }) => {
  await startGuestChat(page);
  await tabToFileInput(page);
  await expectVisibleFocus(page);
});

test('admin: Tab reaches the file input with a visible focus indicator', async ({ newAdminPage, newGuestPage }) => {
  const admin = await newAdminPage();
  await admin.goto('/admin.html');
  const guest = await newGuestPage();
  const { room } = await startGuestChat(guest);
  await sendText(guest, 'keyboard check');
  await openRoom(admin, room);
  // The sidebar holds one tab stop per room (dozens in a shared test DB), so walk from the
  // reply box instead: the attach control must be the adjacent stop before it.
  await admin.locator('#message-input').focus();
  await admin.keyboard.press('Shift+Tab');
  expect(await admin.evaluate(() => document.activeElement.matches('input[type=file]'))).toBe(true);
  await expectVisibleFocus(admin);
});

test('focused text controls show an outline too', async ({ page }) => {
  await page.goto('/guest.html');
  await page.locator('#name').focus();
  await expect(page.locator('#name')).toBeFocused();
  await expectVisibleFocus(page);
});
