import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { AUTH_STATE_PATH, UI_BASE_URL } from './utils/constants';

/**
 * HUMAN-IN-THE-LOOP auth bootstrap, for tenants with MFA.
 *
 * `auth.setup.ts` stays exactly as it was and remains the dependency of the
 * `ui` and `api` projects: where Auth0 serves a plain email/password form, the
 * unattended path is still the right one. This file is the alternative for a
 * tenant with an MFA leg, which no unattended script can complete — a one-time
 * code is, by design, something only the person holding the device can supply.
 *
 * It opens a real browser window, waits for YOU to sign in (password, MFA
 * prompt, "remember this device", whatever the tenant asks for), and the moment
 * it sees an authenticated session it writes the same storageState file the
 * suites already read. Nothing else in the suite needs to change: the specs
 * cannot tell which of the two paths produced the file.
 *
 *   npm run e2e:auth-manual        <- sign in by hand, save the session
 *   npm run e2e:traveler-ui-headed <- then run the tests, watching them
 *
 * It never types or reads your credentials. There is no password in this file
 * and it does not look for one in .env — you type into the real Auth0 form
 * yourself, in your own browser window.
 *
 * Success is NOT judged by what the page looks like. A rendered avatar proves
 * only that the SPA re-rendered; it does not prove the BFF will accept the
 * cookie the tests are about to reuse. So this calls a real authenticated BFF
 * endpoint and requires a 200 before saving. Saving a state file that turns out
 * to be useless is the failure mode worth engineering against — it would
 * surface later as a confusing suite-wide timeout instead of a clear message
 * here.
 */

// Generous: it has to cover reading a code off a phone, and a "remember this
// device" interstitial. Playwright's own default would abort mid-login.
const MANUAL_LOGIN_BUDGET_MS = 8 * 60_000;

// Cheap, read-only, and authenticated — the same endpoint the traveller suites
// depend on. `X-Csrf` matters: the BFF answers "Missing X-Csrf header." without it.
const PROBE_PATH = 'bff/api/make-payable-orchestration/clients?page=1&pageSize=1';

setup('authenticate manually (MFA)', async ({ page, context }) => {
  setup.setTimeout(MANUAL_LOGIN_BUDGET_MS + 60_000);

  await page.goto(UI_BASE_URL);

  console.log(
    [
      '',
      '═══════════════════════════════════════════════════════════════════',
      '  Sign in by hand in the browser window that just opened.',
      '  Complete the MFA prompt as usual. Do not close the window.',
      '',
      `  Waiting up to ${MANUAL_LOGIN_BUDGET_MS / 60_000} minutes; it continues`,
      '  automatically the moment the session is live.',
      '═══════════════════════════════════════════════════════════════════',
      '',
    ].join('\n'),
  );

  // Poll for a working session rather than for a URL or a visible element: the
  // portal briefly shows authenticated-looking chrome before the BFF cookie is
  // usable, and MFA can bounce through several origins on the way.
  const deadline = Date.now() + MANUAL_LOGIN_BUDGET_MS;
  let lastStatus = 0;
  let sessionCookiePresent = false;

  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    sessionCookiePresent = cookies.some((cookie) => cookie.name.includes('tripbuilder.session'));

    if (sessionCookiePresent) {
      // page.request shares the browser context's cookie jar, so this is the
      // same session the tests will inherit — not a separate request context.
      const response = await page.request
        .get(new URL(PROBE_PATH, UI_BASE_URL).toString(), { headers: { 'X-Csrf': '1' } })
        .catch(() => null);

      lastStatus = response?.status() ?? 0;
      if (lastStatus === 200) break;
    }

    await page.waitForTimeout(2_000);
  }

  expect(
    lastStatus,
    sessionCookiePresent
      ? `Signed in, but the BFF rejected the session (last status ${lastStatus}). The saved state would ` +
        'not have worked, so nothing was written. Try again, and if it repeats check whether the account ' +
        'still has access to this environment.'
      : 'No `tripbuilder.session` cookie appeared before the deadline — sign-in was not completed. ' +
        'Nothing was written; the previous state file (if any) is untouched.',
  ).toBe(200);

  mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_PATH });

  console.log(
    [
      '',
      `Session saved to ${AUTH_STATE_PATH}`,
      'Verified against the BFF (HTTP 200), so the suites can use it immediately.',
      '',
      'Sessions expire — the last one lasted under 13 days. When tests start failing',
      'on a "Sign In" page, re-run this.',
      '',
    ].join('\n'),
  );
});
