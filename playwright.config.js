const { defineConfig } = require('@playwright/test');

const baseURL = process.env.SPMS_E2E_URL || 'http://127.0.0.1:5500';

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: true,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 5500 --bind 127.0.0.1',
    url: `${baseURL}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
