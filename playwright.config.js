import { defineConfig, devices } from '@playwright/test';

// In CI a failed test runs once more, only to tell a flaky test from one that
// always fails: a test that passes on its second try still fails the run. The
// failed try keeps its trace (test-results/, uploaded by the workflow).
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.js',
  timeout: 30_000,
  fullyParallel: false,
  retries: ci ? 1 : 0,
  failOnFlakyTests: ci,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], headless: true, trace: ci ? 'retain-on-failure' : 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
