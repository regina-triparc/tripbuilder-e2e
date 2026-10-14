import { expect, type Page } from '@playwright/test';
import { PdpPriceSummaryPage } from '../pages/pdp-price-summary.page';
import { SearchLandingPage } from '../pages/search-landing.page';
import { submitSearchAndIntercept, type PimSearchResultItem } from '../utils/search-interception';

/**
 * Shared configuration and navigation for the PDP suite.
 *
 * The caps below are the PRD's numbers, re-declared here rather than imported from
 * apps/tripbuilder-host. That is deliberate: importing the app's own constants would
 * produce a suite that still passes if someone changed the traveller cap to 20. These are
 * the requirement; the app is the thing under test.
 *
 * Source: "PDP — Payment Summary Panel — Job Story Breakdown" (Confluence 3526623241),
 * Group A, plus "Max Passenger Count Cap — Brief" for the 12.
 */

/** A4 — total travellers across all rooms. */
export const MAX_TRAVELLERS = 12;
/** A1 — the booking API's room ceiling. Independent of the traveller cap; whichever binds first wins. */
export const MAX_ROOMS = 4;
/** Per-room supplier ceilings. NOTE: these are "Product to confirm" item 4 — see the README. */
export const MAX_ADULTS_PER_ROOM = 10;
export const MAX_CHILDREN_PER_ROOM = 4;
/** A3 — child-age bounds. */
export const MIN_CHILD_AGE = 0;
export const MAX_CHILD_AGE = 17;

/**
 * Which package the suite drives.
 *
 * `TB_PDP_TEMPLATE_SLUG` pins it and skips search entirely — preferred for a repeatable
 * run. Otherwise the suite takes the advisor's route: type the brief on /slp, submit, and
 * open a card from the results. `TB_PDP_TEMPLATE_TITLE` picks a specific card when it is
 * present; when it is not, the FIRST result is used rather than failing, because these
 * cases assert the price rail's behaviour and any published package exercises it.
 */
/**
 * Defaults to the package the panel was reviewed on — "Rome In Style", verified published
 * in UAT on 2026-09-15 by opening it through the real search flow and reading the slug
 * back off the result. Pinned rather than left to search because the curated query the
 * fixtures ship ("Rome for a couple, 10 days, budget 4000 EUR") returned ZERO packages on
 * that same run: ranking is LLM-backed, so the search path is a fallback, not a foundation.
 *
 * Set TB_PDP_TEMPLATE_SLUG='' (empty) to force the search route instead.
 */
export const TEMPLATE_SLUG =
  process.env.TB_PDP_TEMPLATE_SLUG === undefined
    ? 'rome-luxe-6day-culture'
    : process.env.TB_PDP_TEMPLATE_SLUG.trim() || undefined;
export const TEMPLATE_TITLE = process.env.TB_PDP_TEMPLATE_TITLE?.trim() || 'Rome In Style';
export const SEARCH_QUERY =
  process.env.TB_PDP_SEARCH_QUERY?.trim() || 'Rome for a couple, 10 days, budget 4000 EUR';

/**
 * AUTH: ONCE PER SUITE, NOT PER TEST.
 *
 * The `pdp` project declares `dependencies: ['setup']` and `storageState: AUTH_STATE_PATH`,
 * so `auth.setup.ts` signs in one time per invocation and every test in this suite inherits
 * that session. Nothing here logs in, warms a session, or touches credentials.
 *
 * An earlier revision of this file navigated to `/slp` at the start of EVERY test to
 * "warm" the session. That was the wrong fix for the right symptom: the suite had been
 * invoked with `--no-deps`, which skips the setup project, so every context started with
 * stale cookies and a deep link to `/pdp?template=…` bounced through
 * `/bff/login?returnUrl=%2Fslp` -> Auth0 -> Entra SSO and landed on `/slp` with the
 * requested path discarded. With the dependency running, the cookies are valid and the
 * deep link resolves directly — one sign-in, twelve tests.
 *
 * `npm run e2e:pdp` / `e2e:pdp-headed` run the dependency. Use `e2e:pdp-manual` only
 * AFTER `e2e:auth-manual` has written a session by hand (MFA tenants) — that variant
 * passes `--no-deps` deliberately, because the state file already exists.
 */

/** The result the suite will open, and the slug worth pinning for next time. */
export interface ChosenPackage {
  title: string;
  slug: string;
  fromSearch: boolean;
}

/**
 * Opens the PDP price rail, by pinned slug when configured and through the real search
 * flow otherwise, and returns the package it landed on.
 *
 * The search path reuses `submitSearchAndIntercept`, the same helper the search suite
 * uses, so the card it clicks is one the response actually returned — not a title this
 * file hoped would rank.
 */
export async function openPdp(page: Page): Promise<{ rail: PdpPriceSummaryPage; chosen: ChosenPackage }> {
  const rail = new PdpPriceSummaryPage(page);

  if (TEMPLATE_SLUG) {
    await page.goto(`/pdp?template=${encodeURIComponent(TEMPLATE_SLUG)}`);
    await rail.waitForRail();
    return { rail, chosen: { title: TEMPLATE_SLUG, slug: TEMPLATE_SLUG, fromSearch: false } };
  }

  const landing = new SearchLandingPage(page);
  const { responseBody } = await submitSearchAndIntercept(page, landing, SEARCH_QUERY);
  const items = responseBody.items ?? [];

  if (items.length === 0) {
    throw new Error(
      `The search for "${SEARCH_QUERY}" returned zero packages, so there is no PDP to open. ` +
        'Set TB_PDP_TEMPLATE_SLUG to pin a published package instead.',
    );
  }

  const preferred: PimSearchResultItem | undefined = items.find((item) =>
    item.title?.toLowerCase().includes(TEMPLATE_TITLE.toLowerCase()),
  );
  const item = preferred ?? items[0];

  // The search suite proves the card's accessible name is the item's title.
  const card = page.getByRole('button', { name: item.title });
  await expect(
    card,
    `the response returned "${item.title}" but no result card with that name rendered`,
  ).toBeVisible({ timeout: 60_000 });
  await card.click();
  await rail.waitForRail();

  if (!preferred) {
    // Not a failure — but say so, so a reader of the report knows which package the
    // assertions actually ran against.
    console.log(
      `[pdp] "${TEMPLATE_TITLE}" was not in the results for "${SEARCH_QUERY}"; ` +
        `opened "${item.title}" instead. Pin it with TB_PDP_TEMPLATE_SLUG=${item.slug}`,
    );
  } else {
    console.log(`[pdp] opened "${item.title}" — pin it with TB_PDP_TEMPLATE_SLUG=${item.slug}`);
  }

  return { rail, chosen: { title: item.title, slug: item.slug, fromSearch: true } };
}
