import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.js',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
