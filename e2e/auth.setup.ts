import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';
import { LandingPage } from './pages/landing.page';
import { AUTH_STATE_PATH } from './utils/constants';

/**
 * Auth bootstrap for the deployed-portal suite.
 *
 * UAT's Auth0 tenant serves a plain email/password form with no MFA leg, so
 * this runs unattended as a dependency of the ui and api projects. The
 * resulting storageState (session cookies, incl. `__Host-tripbuilder.session`)
 * is saved to AUTH_STATE_PATH and reused by both, so the sign-in happens once
 * per run rather than once per test. Add `--headed` (see `npm run e2e:auth`)
 * to watch the flow when debugging it.
 *
 * Credentials come from a local .env file (loaded by playwright.config.ts
 * via dotenv — see .env.example) — never hardcode them in a spec file.
 */
const EMAIL = process.env['TBA_E2E_EMAIL'];
const PASSWORD = process.env['TBA_E2E_PASSWORD'];

setup('authenticate against deployed portal', async ({ page }) => {
  // The config's 60s default covers an API row, not a cold MFE shell plus two
  // Auth0 redirects; a slow render was timing this out on a sign-in that works.
  setup.setTimeout(180_000);

  if (!EMAIL || !PASSWORD) {
    throw new Error(
      '[auth.setup] TBA_E2E_EMAIL and TBA_E2E_PASSWORD must be set.\n' +
        'Copy .env.example to .env in the repo root and fill in your password.\n' +
        'Never hardcode credentials in spec files.',
    );
  }

  const landing = new LandingPage(page);
  await landing.goto();
  await landing.startSignIn(EMAIL);
  await landing.completeSignIn(PASSWORD);

  // DEV lands a signed-in advisor on /trips (observed 2026-10-06). Waiting only for
  // /slp|/srp timed the setup out on a session that had in fact signed in successfully,
  // which failed every dependent project before a single assertion ran.
  await page.waitForURL(/\/(slp|srp|trips)/, { timeout: 60_000 });

  mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
