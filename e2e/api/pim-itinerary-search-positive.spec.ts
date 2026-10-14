import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { loadCsvFixture, groupBy } from '../helpers/csv';
import { buildCurlCommand, cookieHeaderFromStorageState } from '../helpers/curl';
import { annotateXray, attachFailures, safeDbCheck } from '../helpers/report';
import { API_BASE_URL, AUTH_STATE_PATH } from '../utils/constants';
import type { PimSearchResponseBody } from '../utils/search-interception';
import {
  assertInterpretedQuery,
  assertItemsMatchQuery,
  assertMustNotIncludeCity,
  assertResponseEnumsValid,
  type NlSearchExpectations,
} from '../utils/search-assertions';
import { assertLiveSearchDocBacksItem, assertProductBackedBySearchItem, isPimDbConfigured } from '../utils/pim-db';

/**
 * API-only, data-driven coverage of POST /bff/api/tripagents/chat/pim-itinerary-search
 * against the deployed portal's BFF — no browser/UI involved. Loops over
 * the FULL dataset in fixtures/pim-search-positive-dataset.csv (cheap, since
 * it's a direct HTTP call per row) and asserts interpretedQuery accuracy via
 * the same helpers the UI suite uses — see ui/search.spec.ts for the
 * browser-driven, capped counterpart, and utils/search-assertions.ts for
 * the shared assertion logic.
 *
 * This is the "positive" half of the split described in the search-e2e
 * README — every row here expects a real, resolvable destination and a
 * non-empty result set. See pim-itinerary-search-negative.spec.ts for the
 * counterpart that expects zero results (nonexistent destination, budget/
 * group-size facets set beyond what live inventory can satisfy).
 *
 * Rows are grouped into `test.describe` blocks by the CSV's `category`
 * column — the facet or facet-combination each row is isolating (e.g.
 * pax-phrasing, granularity-state, currency, template-phrasing). The CSV
 * itself is physically grouped the same way (blank-line-separated blocks),
 * so the file on disk and the Playwright report tree read the same —
 * see fixtures/pim-search-positive-dataset.csv.
 *
 * Auth: reuses the `__Host-tripbuilder.session` cookie captured by
 * auth.setup.ts via storageState (see playwright.config.ts) — no
 * separate token minting needed.
 *
 * Path is relative (no leading "/") because the `api` project's baseURL is
 * .../bff/api/ — a leading slash would resolve against the origin root and
 * drop that prefix, per Playwright/WHATWG URL-joining rules.
 */

type CsvRow = NlSearchExpectations & {
  id: string;
  category: string;
  expectedCurrency: string;
  mustNotIncludeCity: string;
  notes: string;
  xrayKey: string;
};

const rows = loadCsvFixture<CsvRow>(__dirname, 'fixtures/pim-search-positive-dataset.csv');
const rowsByCategory = groupBy(rows, (r) => r.category);

const PIM_SEARCH_PATH = 'tripagents/chat/pim-itinerary-search';

test.describe('pim-itinerary-search API — data-driven interpretedQuery accuracy (positive)', () => {
  for (const [category, categoryRows] of rowsByCategory) {
    test.describe(category, () => {
      for (const row of categoryRows) {
        test(`${row.id}: "${row.query}"`, async ({ request }, testInfo) => {
          annotateXray(testInfo, row.xrayKey);
          const requestBody = { query: row.query, page: 1, pageSize: 20, sessionId: randomUUID() };
          const requestHeaders = { 'x-csrf': '1', 'Content-Type': 'application/json' };

          // Attached before the call resolves so it survives even if the request itself throws/times out.
          await testInfo.attach('curl', {
            body: buildCurlCommand({
              method: 'POST',
              url: new URL(PIM_SEARCH_PATH, API_BASE_URL).toString(),
              headers: { ...requestHeaders, Cookie: cookieHeaderFromStorageState(AUTH_STATE_PATH, API_BASE_URL) },
              body: requestBody,
            }),
            contentType: 'text/plain',
          });

          const response = await request.post(PIM_SEARCH_PATH, { headers: requestHeaders, data: requestBody });

          if (!response.ok()) {
            const bodyText = await response.text();
            await testInfo.attach('response-error', {
              body: `status: ${response.status()}\n\n${bodyText}`,
              contentType: 'text/plain',
            });
            expect(response.ok(), `request failed: ${response.status()} ${bodyText}`).toBeTruthy();
          }

          const body = (await response.json()) as PimSearchResponseBody;

          // Every check below is collected into one list and asserted once at
          // the end — a DB check throwing (Mongo blip, etc.) is caught by
          // safeDbCheck() rather than aborting the test, so it can never
          // silently discard failures already found by the checks above it.
          const failures = [
            ...assertInterpretedQuery(body.interpretedQuery ?? {}, row),
            ...assertItemsMatchQuery(body.items ?? [], row),
            ...assertMustNotIncludeCity(body.items ?? [], row.mustNotIncludeCity),
            ...assertResponseEnumsValid(body.interpretedQuery ?? {}, body.items ?? []),
            ...((body.items ?? []).length === 0 ? ['response returned zero items'] : []),
          ];

          // --- DB ground truth: only runs on VPN-connected machines (PIM_MONGODB_URI set) ---
          if (isPimDbConfigured()) {
            const firstItem = (body.items ?? [])[0];
            if (firstItem) {
              failures.push(...(await safeDbCheck('stockroom.products check', () => assertProductBackedBySearchItem(firstItem))));
              failures.push(...(await safeDbCheck('marketplace.product-live-search check', () => assertLiveSearchDocBacksItem(firstItem, row))));
            }
          } else {
            testInfo.annotations.push({
              type: 'note',
              description: 'DB ground-truth checks skipped — PIM_MONGODB_URI not set, see .env.example',
            });
          }

          await attachFailures(testInfo, failures);
          expect(failures, failures.join('; ')).toEqual([]);
        });
      }
    });
  }
});
