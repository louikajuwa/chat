const { defineConfig } = require('@playwright/test');

const vp = (name, width, height) => ({
  name,
  use: { browserName: 'chromium', viewport: { width, height } },
});

module.exports = defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup.js'),
  outputDir: 'test-results',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 2,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://app-e2e:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    vp('mobile-375', 375, 812),
    vp('mobile-390', 390, 844),
    vp('tablet-768', 768, 1024),
    vp('desktop-1366', 1366, 768),
    vp('desktop-1920', 1920, 1080),
  ],
});
