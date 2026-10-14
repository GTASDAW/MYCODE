import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.AUTH_RATE_LIMIT_E2E === '1' ? undefined : ['**/auth-rate-limit.spec.ts'],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  timeout: 60000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
