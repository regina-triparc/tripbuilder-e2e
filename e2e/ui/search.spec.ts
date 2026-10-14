import { test, expect } from '@playwright/test';
import { loadCsvFixture } from '../helpers/csv';
import { annotateXray, attachFailures, safeDbCheck } from '../helpers/report';
import { SearchLandingPage } from '../pages/search-landing.page';
import { SearchResultsPage } from '../pages/search-results.page';
import { submitSearchAndIntercept } from '../utils/search-interception';
import {
  assertInterpretedQuery,
  assertRequestPayloadShape,
  assertResponseEnumsValid,
  type NlSearchExpectations,
} from '../utils/search-assertions';
import { assertProductBackedBySearchItem, isPimDbConfigured } from '../utils/pim-db';

/**
 * UI + API combined, data-driven coverage of the deployed portal's search
 * flow: drives the real /slp -> Submit -> /srp UI path while intercepting
 * both the outgoing POST .../pim-itinerary-search request payload and its
 * response, so assertions cover:
 *   - the request sent is exactly what the user typed — no stray search
 *     params leaking into the payload beyond query/page/pageSize/sessionId
 *   - the response's interpretedQuery / facets match what the query implies
 *
 * Deliberately capped to a handful of rows (UI_DATASET_LIMIT) — each row
 * drives a real browser through a real LLM-backed agent call, so this is
 * slow. The full dataset lives in api/pim-itinerary-search-positive.spec.ts
 * (plus the negative counterpart), which is cheap (no browser) and loops
 * every row. Assertion logic is shared
 * between both suites via utils/search-assertions.ts.
 */

type CsvRow = NlSearchExpectations & { id: string; category: string; notes: string; xrayKey: string };

const UI_DATASET_LIMIT = 11;
const rows = loadCsvFixture<CsvRow>(__dirname, 'fixtures/nl-search-ui-dataset.csv').slice(0, UI_DATASET_LIMIT);

test.describe('Search — UI + API, data-driven', () => {
  for (const row of rows) {
    test(`${row.id}: "${row.query}"`, async ({ page }, testInfo) => {
      test.slow();
      annotateXray(testInfo, row.xrayKey);
      const searchLanding = new SearchLandingPage(page);
      const searchResults = new SearchResultsPage(page);

      await searchLanding.goto();
      const { requestPayload, responseBody } = await submitSearchAndIntercept(page, searchLanding, row.query);

      // Every check below (request shape, interpretedQuery, DB ground truth)
      // is collected into one list and asserted once at the end — a DB check
      // throwing (Mongo blip, etc.) is caught by safeDbCheck() rather than
      // aborting the test, so it can never silently discard failures already
      // found by the checks above it.
      const failures = [
        ...assertRequestPayloadShape(requestPayload, row.query),
        ...assertInterpretedQuery(responseBody.interpretedQuery ?? {}, row),
        ...assertResponseEnumsValid(responseBody.interpretedQuery ?? {}, responseBody.items ?? []),
        ...((responseBody.items ?? []).length === 0 ? ['response returned zero items'] : []),
      ];

      const firstItem = responseBody.items[0];

      // --- DB ground truth: only runs on VPN-connected machines (PIM_MONGODB_URI set) ---
      if (isPimDbConfigured()) {
        if (firstItem) {
          failures.push(...(await safeDbCheck('stockroom.products check', () => assertProductBackedBySearchItem(firstItem))));
        }
      } else {
        testInfo.annotations.push({
          type: 'note',
          description: 'DB ground-truth checks skipped — PIM_MONGODB_URI not set, see .env.example',
        });
      }

      await attachFailures(testInfo, failures);
      expect(failures, failures.join('; ')).toEqual([]);

      // --- cheap UI-shape sanity: the rendered page reflects the same response ---
      // Kept as separate locator assertions (not folded into `failures`) so
      // Playwright's auto-retry/auto-wait still applies — these can be
      // legitimately slow to settle even when the API response was correct.
      await expect(searchResults.resultsSummary).toBeVisible();
      if (firstItem) {
        await searchResults.expectResultVisible(firstItem.title);
      }
    });
  }
});
