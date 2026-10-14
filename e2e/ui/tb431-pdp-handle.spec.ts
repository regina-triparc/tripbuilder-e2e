import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { API_BASE_URL } from '../utils/constants';

/**
 * TB-431 — ruling R-E: `/pdp?productId=<id>` is the ONLY handle the PDP opens on.
 *
 * The pre-Phase-4 `?template=` / `?slug=` deep links must render the "no longer available"
 * state WITHOUT issuing a request — the slug-keyed read path is gone, and a link that
 * silently resolved one again would be the fallback the migration plan forbids. Bookmarks,
 * the older QA fixtures in e2e/pdp, and anything pasted into a chat all carry slugs, so this
 * is the behaviour an advisor is most likely to meet first.
 */

const GONE = /no longer available/i;

async function firstProductId(request: { post: Function }): Promise<string> {
  const response = await request.post(new URL('tripagents/chat/product-search', API_BASE_URL).toString(), {
    headers: { 'x-csrf': '1', 'Content-Type': 'application/json' },
    data: { query: 'Italy', page: 1, pageSize: 20, sessionId: randomUUID() },
  });
  expect(response.status()).toBe(200);
  const id = ((await response.json()).items ?? [])[0]?.id;
  expect(id, 'discovery returned no product to open').toBeTruthy();
  return id;
}

test('a productId deep link opens the PDP', async ({ page, request }) => {
  const productId = await firstProductId(request);
  await page.goto(`/pdp?productId=${productId}`);
  await expect(page.getByText(GONE), `/pdp?productId=${productId} rendered the unavailable state`).toHaveCount(0);
});

test('a legacy template/slug deep link renders the unavailable state', async ({ page }) => {
  await page.goto('/pdp?template=rome-luxe-6day-culture');
  await expect(page.getByText(GONE)).toBeVisible();
});

/**
 * D1 (QA notes, 6 Oct 2026) — **resolved on DEV 14 Oct 2026**, and this case is the pin for it.
 *
 * It was written the other way up: discovery surfaced PIG products carrying Embedded lines, the
 * read route refused them with 502 (`ProductContractViolationException`), and the case asserted
 * the advisor at least met the graceful state rather than a broken shell. It was pinned to a
 * specific id on purpose, to start failing when the Embedded work landed — which is exactly what
 * it did once DEV picked up #762. Inverted rather than deleted, so this id keeps proving the thing
 * that actually matters now: the product opens.
 */
test('an Embedded-line product deep link opens the PDP (D1 resolved)', async ({ page }) => {
  await page.goto('/pdp?productId=6abd8c9f3c0d5ede86d0d602');
  await expect(page.getByText(GONE), 'the Embedded product is unopenable again — D1 has regressed').toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Porto: Tiles, Tastings & the Douro/i })).toBeVisible();
});
