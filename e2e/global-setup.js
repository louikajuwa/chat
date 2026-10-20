// Logs in as admin ONCE (login is limited to 5/min/IP) and stores the session for all tests.
const fs = require('fs');
const path = require('path');
const { request } = require('@playwright/test');

const STATE = path.join(__dirname, '.auth', 'admin.json');

module.exports = async () => {
  const baseURL = process.env.BASE_URL || 'http://app-e2e:3000';
  if (!process.env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is not set');
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/admin/login', {
    form: { password: process.env.ADMIN_PASSWORD },
    maxRedirects: 0,
  });
  const loc = res.headers().location || '';
  if (res.status() !== 303 || !loc.endsWith('/admin.html')) {
    throw new Error(`Admin login failed (status ${res.status()}, location ${loc})`);
  }
  await ctx.storageState({ path: STATE });
  await ctx.dispose();
};

module.exports.STATE = STATE;
