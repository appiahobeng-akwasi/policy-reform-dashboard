// End-to-end tests: a real browser against the built app and a local Supabase stack
// (`supabase start`, then `npm run db:reset`). Sign-in emails are read from the local mail
// catcher (Mailpit). Run with `npm run test:e2e`.
//
// The tests always build and start their own server on port 4329, so a development server
// on 4321 (npm run dev) is never tested by mistake.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4329;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'en-GB',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.CI ? 'npm start' : 'npm run build && npm start',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    // Every test signs in from this machine, so this address is exempt from the per-address
    // limits (per-email and per-person limits still apply); the failing test page is switched on.
    env: { HOST: 'localhost', PORT: String(PORT), ENABLE_TEST_ROUTES: 'true', RATE_LIMIT_IP_EXEMPT: '127.0.0.1,::1,::ffff:127.0.0.1' },
  },
});
