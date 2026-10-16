import { defineConfig, devices } from '@playwright/test';

// Production assets only. No SQL fixtures or the ordinary suite's global setup.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/loading.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  outputDir: process.env.LOADING_OUTPUT_DIR ?? '.runtime/frontend-loading/browser-results',
  reporter: [['list'], ['html', {
    open: 'never', outputFolder: process.env.LOADING_REPORT_DIR ?? '.runtime/frontend-loading/browser-report',
  }]],
  use: {
    baseURL: process.env.LOADING_BASE_URL ?? 'http://127.0.0.1:5185',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
