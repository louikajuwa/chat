const zlib = require('zlib');
const crypto = require('crypto');
const base = require('@playwright/test');
const { STATE } = require('../global-setup');

// ---- PNG generator (valid, solid colour) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngBuffer(w = 16, h = 16) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const uniqueName = (p = 'Guest') => `${p}${crypto.randomBytes(4).toString('hex')}`;

// ---- Console / CSP watcher ----
function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /content security policy/i.test(m.text())) {
      errors.push(`console.${m.type()}: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const test = base.test.extend({
  // Factory: new admin page (separate context, logged in via the shared storageState).
  newAdminPage: async ({ browser, baseURL, viewport }, use) => {
    const ctxs = [];
    await use(async () => {
      const ctx = await browser.newContext({ baseURL, viewport, storageState: STATE });
      ctxs.push(ctx);
      return ctx.newPage();
    });
    await Promise.all(ctxs.map((c) => c.close()));
  },
  // Factory: new anonymous guest page in its own context (own localStorage).
  newGuestPage: async ({ browser, baseURL, viewport }, use) => {
    const ctxs = [];
    await use(async () => {
      const ctx = await browser.newContext({ baseURL, viewport });
      ctxs.push(ctx);
      return ctx.newPage();
    });
    await Promise.all(ctxs.map((c) => c.close()));
  },
});

const { expect } = base;

// ---- Page helpers ----
async function startGuestChat(page, name = uniqueName()) {
  await page.goto('/guest.html');
  await page.locator('#name').fill(name);
  await page.locator('#onboard-form button[type=submit]').click();
  await expect(page.locator('#chat')).toBeVisible();
  // The composer is enabled only after the server acked guestConnected.
  await page.locator('#message-input').fill('.');
  await expect(page.locator('#send-btn')).toBeEnabled();
  await page.locator('#message-input').fill('');
  const room = await page.evaluate(() => localStorage.getItem('room'));
  return { name, room };
}

async function sendText(page, text) {
  await page.locator('#message-input').fill(text);
  await expect(page.locator('#send-btn')).toBeEnabled();
  await page.locator('#send-btn').click();
  await expect(page.locator('#messages')).toContainText(text);
}

const isMobile = (page) => page.viewportSize().width < 768;

// Opens the mobile drawer when the inbox is hidden behind it.
async function ensureInboxVisible(adminPage) {
  const toggle = adminPage.locator('#drawer-toggle');
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
}

async function openRoom(adminPage, room) {
  await ensureInboxVisible(adminPage);
  const card = adminPage.locator(`#room-list button[data-room="${room}"]`);
  await expect(card).toBeVisible();
  await card.click();
  await expect(adminPage.locator('#chat-view')).toBeVisible();
}

module.exports = {
  test, expect, pngBuffer, uniqueName, watchErrors,
  startGuestChat, sendText, isMobile, ensureInboxVisible, openRoom,
};
