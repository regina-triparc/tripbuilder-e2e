import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig, devices } from '@playwright/test';
import { UI_BASE_URL, API_BASE_URL, AUTH_STATE_PATH } from './e2e/utils/constants';

/**
 * Playwright project for search-e2e — POM-based UI+API search coverage
 * plus a data-driven API-only suite, both against the real deployed
 * tripbuilder-portal (no local dev servers / localhost).
 *
 * Auth: put TBA_E2E_EMAIL / TBA_E2E_PASSWORD in a local .env file (see
 * .env.example — gitignored, never commit the real one). The `setup` project
 * signs in unattended and saves storageState to e2e/.auth/state.json; it runs
 * as a dependency of both `ui` and `api`, so a plain `npm run e2e` refreshes
 * auth on its own. `npm run e2e:auth` runs it headed for debugging.
 */
dotenv.config({ path: path.join(__dirname, '.env') });

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-artifacts',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // The `api` project is browser-free and every row mints its own sessionId,
  // so its rows are independent and were only ever serialised by this setting.
  // Tunable because the rows hit a real LLM-backed agent — raise it until
  // trip-agents starts rate-limiting, lower it if a shared run needs to be
  // gentle. The `ui` project stays serial via its own fullyParallel: false.
  workers: Number(process.env.E2E_WORKERS ?? 4),
  retries: 0,
  fullyParallel: false,
  // Real LLM-backed calls can take well past Playwright's default timeouts.
  timeout: 60_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
    // Batches the run into one Xray Cloud Test Execution with per-test failure
    // evidence. No-ops with a warning when XRAY_* env vars are unset.
    ['./e2e/reporters/xray-reporter.ts'],
  ],

  use: {
    baseURL: UI_BASE_URL,
    // Both retain-on-failure rather than on-first-retry: retries are 0 here
    // (an LLM-backed suite that passes on retry is still a finding), so
    // on-first-retry would mean never capturing a trace at all.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Browser-only, so this yields video for the `ui` project; the `api`
    // project's evidence is its curl reproduction + assertion dump instead.
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testMatch: 'auth.setup.ts',
      // Headless like every other project — the Auth0 form has no MFA leg,
      // so nothing here needs a human. `npm run e2e:auth` passes --headed
      // when you want to watch the sign-in while debugging it.
      use: { ...devices['Desktop Chrome'], baseURL: UI_BASE_URL },
    },
    {
      name: 'ui',
      testMatch: 'ui/**/*.spec.ts',
      dependencies: ['setup'],
      // Serial on purpose: each row drives a real browser through the same
      // portal session, and parallel browsers multiply flake for no gain when
      // the bottleneck is agent latency, not local CPU.
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'], baseURL: UI_BASE_URL, storageState: AUTH_STATE_PATH },
    },
    {
      name: 'api',
      testMatch: 'api/**/*.spec.ts',
      dependencies: ['setup'],
      // Per-test parallelism (not just per-file): the positive and negative
      // datasets are one file each, so file-level parallelism alone would
      // still run all 40+ positive rows single-file.
      fullyParallel: true,
      use: { baseURL: API_BASE_URL, storageState: AUTH_STATE_PATH, headless: true },
    },
    {
      // Human-in-the-loop sign-in for an MFA tenant. Deliberately NOT a
      // dependency of any project: it needs a person, so it must never be
      // pulled into an automated run. Invoke it on its own via
      // `npm run e2e:auth-manual`, then run the suites, which read the same
      // storageState file the unattended `setup` project writes.
      name: 'setup-manual',
      testMatch: 'auth-manual.setup.ts',
      // headless: false here rather than relying on --headed, so the script
      // cannot be run blind by accident — there is nothing to type into an
      // invisible window.
      use: { ...devices['Desktop Chrome'], baseURL: UI_BASE_URL, headless: false, video: 'off', trace: 'off' },
    },
    {
      name: 'traveler',
      // Named file, not a glob: traveler-info-ui.spec.ts lives in the same
      // folder but needs a browser and a session, so it belongs to the
      // traveler-ui project below. A `traveler/**` glob here would drag it in
      // and it would fail for want of storageState.
      testMatch: 'traveler/traveler-info-event.spec.ts',
      // No `setup` dependency and no storageState on purpose: these are
      // make-payable DB ground-truth checks (TB-271), so they need neither a
      // browser nor a portal session. Adding the dependency would make the
      // suite fail on an Auth0 problem that has nothing to do with what it
      // asserts. The UI-driven leg sketched at the bottom of the spec will
      // need `dependencies: ['setup']` when it is written — split it into its
      // own project then rather than coupling these.
      fullyParallel: true,
      // No browser is ever launched here, so video/screenshot/trace would all be
      // empty files. Turned off explicitly rather than inherited-and-unused, so
      // an empty artifact folder is never mistaken for lost evidence. This
      // project's failure evidence is the SQL trace attached by
      // helpers/failure-artifacts.ts instead.
      use: { headless: true, video: 'off', screenshot: 'off', trace: 'off' },
    },
    {
      // Hotel (and later, other) service flows on the trip's Itinerary tab.
      // Its own project rather than a folder inside traveler-ui: these assert
      // against shopping-gateway, not make-payable, so a failure here should
      // never read as a traveller-event failure.
      name: 'services-hotel',
      testMatch: 'services/hotel/**/*.spec.ts',
      dependencies: ['setup'],
      fullyParallel: false,
      workers: 1,
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'], baseURL: UI_BASE_URL, storageState: AUTH_STATE_PATH },
    },
    {
      // PDP price-rail party composition + start date (PRD 3526623241, groups A and B1).
      // Its own project rather than a folder under `ui`: the `ui` project is the curated
      // SEARCH surface, and a rail failure should never read as a search failure. Serial
      // and single-worker because each case re-opens the same package page and drives its
      // steppers — parallel workers would just multiply portal load for no gain.
      name: 'pdp',
      testMatch: 'pdp/**/*.spec.ts',
      dependencies: ['setup'],
      fullyParallel: false,
      workers: 1,
      // Reaching the rail can include an LLM-backed search leg (when no slug is pinned)
      // plus a PIM template resolve, and the cap cases then issue ~20 stepper clicks.
      timeout: 240_000,
      use: { ...devices['Desktop Chrome'], baseURL: UI_BASE_URL, storageState: AUTH_STATE_PATH },
    },
    {
      name: 'traveler-ui',
      testMatch: 'traveler/traveler-info-ui.spec.ts',
      dependencies: ['setup'],
      // Serial, and NOT fullyParallel: the five cases share one trip and build
      // on each other the way an advisor uses the page ("Add traveller" is
      // disabled until a client is attached). Parallel workers would race for
      // the same offer and produce failures that say nothing about the product.
      fullyParallel: false,
      workers: 1,
      // Each case waits on an async chain (202 -> internal bus -> outgoing
      // handler -> append -> publish), and the negative cases deliberately sit
      // through a 30s quiet window, so the global 60s timeout is far too tight.
      timeout: 240_000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: UI_BASE_URL,
        storageState: AUTH_STATE_PATH,
        // Stated explicitly rather than inherited from the top-level `use`:
        // these tests are the reason someone opens the report, and a reader
        // should be able to see what evidence to expect without cross-checking
        // two places.
        //
        // retain-on-failure, not on-first-retry: this project runs with
        // retries: 0, so on-first-retry would capture nothing, ever.
        video: { mode: 'retain-on-failure', size: { width: 1280, height: 720 } },
        screenshot: 'only-on-failure',
        // screenshots + snapshots make the trace viewer usable for a UI failure
        // (DOM at each step, not just a list of actions); sources off keeps the
        // zip small enough to attach to a ticket.
        trace: { mode: 'retain-on-failure', screenshots: true, snapshots: true, sources: false },
      },
    },
    {
      // Specs written by the autonomous QA agent (TAF service), one file per Jira
      // ticket under e2e/qa/<TICKET>.spec.ts.
      //
      // Its own project because every other project here matches a curated folder:
      // without an entry whose testMatch covers e2e/qa, a generated spec belongs to
      // no project and `playwright test` reports zero tests rather than failing.
      //
      // baseURL falls back to UI_BASE_URL so a human running `--project=qa-agent`
      // behaves exactly like the other suites; the QA service overrides it per run
      // by exporting BASE_URL for the environment under test.
      name: 'qa-agent',
      testMatch: 'qa/**/*.spec.ts',
      dependencies: ['setup'],
      fullyParallel: false,
      workers: 1,
      // Generated specs drive the same portal as `ui`, including LLM-backed legs.
      timeout: 180_000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.BASE_URL ?? UI_BASE_URL,
        storageState: AUTH_STATE_PATH,
      },
    },
  ],
});
