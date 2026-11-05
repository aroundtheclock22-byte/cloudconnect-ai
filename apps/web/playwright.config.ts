import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suite. Expects the API (with seeded demo tenant) on :4000 and the web app on :3000.
 * CI starts both via docker compose (see .github/workflows/ci.yml).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', trace: 'off' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
  ],
});
