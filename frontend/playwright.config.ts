import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL } from './e2e/helpers/urls';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

process.env.FLO_E2E_JWT_SECRET ??= randomBytes(32).toString('hex');

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  testIgnore: /.*\.electron\.spec\.ts/,
  workers: 1, // Single shared backend server requires serial execution to prevent DB state races
  retries: process.env.CI ? 1 : 0,
  use: {
    headless: true,
    trace: 'on-first-retry', // Upload traces for debugging CI flakes
  },
  webServer: {
    command: 'node tests/e2e-server.cjs',
    wait: { stdout: /^\[E2E\] Main, KDS, and Server App servers ready$/m },
    reuseExistingServer: false,
    timeout: 120_000,
    cwd: path.resolve(__dirname, '..'),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: E2E_BASE_URL } }],
});
