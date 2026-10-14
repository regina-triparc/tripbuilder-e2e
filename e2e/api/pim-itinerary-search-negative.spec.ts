import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { loadCsvFixture, groupBy } from '../helpers/csv';
import { buildCurlCommand, cookieHeaderFromStorageState } from '../helpers/curl';
import { annotateXray, attachFailures } from '../helpers/report';
import { API_BASE_URL, AUTH_STATE_PATH } from '../utils/constants';
import type { PimSearchResponseBody } from '../utils/search-interception';
import { assertInterpretedQuery, assertResponseEnumsValid, type NlSearchExpectations } from '../utils/search-assertions';

/**
 * API-only, data-driven coverage of POST /bff/api/tripagents/chat/pim-itinerary-search
 * for queries that should return ZERO results — the negative counterpart to
 * pim-itinerary-search-positive.spec.ts. See that file's header and the
 * search-e2e README for the split rationale.
 *
 * fixtures/pim-search-negative-dataset.csv is generated fresh by
 * globalSetup (see generate-negative-facet-dataset.ts) from live inventory
 * ground truth — thresholds like "budget above the max price anywhere" or
 * "group size above the max anywhere" only stay true if regenerated
 * on-VPN, so this whole suite is skipped when that fixture isn't present
 * (i.e. PIM_MONGODB_URI wasn't set for this run).
 *
 * Rows are grouped into `test.describe` blocks by the CSV's
 * `facetsUnderTest` column — mirrors the positive spec's grouping by
 * `category` (see that file's header) so both reports read the same way:
 * one block per facet/facet-combination being isolated.
 */

type CsvRow = NlSearchExpectations & {
  id: string;
  category: string;
  expectedCurrency: string;
  facetsUnderTest: string;
  expectedOutcome: string;
  notes: string;
  xrayKey: string;
};

const FIXTURE_PATH = 'fixtures/pim-search-negative-dataset.csv';
const fixtureExists = existsSync(path.join(__dirname, FIXTURE_PATH));
const rows = fixtureExists ? loadCsvFixture<CsvRow>(__dirname, FIXTURE_PATH) : [];
const rowsByFacet = groupBy(rows, (r) => r.facetsUnderTest);

const PIM_SEARCH_PATH = 'tripagents/chat/pim-itinerary-search';

test.describe('pim-itinerary-search API — data-driven zero-result facet coverage (negative)', () => {
  test.skip(!fixtureExists, `${FIXTURE_PATH} not generated — requires PIM_MONGODB_URI (VPN) for globalSetup to derive live thresholds`);

  for (const [facetsUnderTest, facetRows] of rowsByFacet) {
    test.describe(facetsUnderTest, () => {
      for (const row of facetRows) {
        test(`${row.id}: "${row.query}"`, async ({ request }, testInfo) => {
          annotateXray(testInfo, row.xrayKey);
          const requestBody = { query: row.query, page: 1, pageSize: 20, sessionId: randomUUID() };
          const requestHeaders = { 'x-csrf': '1', 'Content-Type': 'application/json' };

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
          const items = body.items ?? [];
          const interpreted = body.interpretedQuery ?? {};

          const failures = [
            ...assertInterpretedQuery(interpreted, row),
            ...assertResponseEnumsValid(interpreted, items),
            ...(row.expectedOutcome === 'no-results' && items.length > 0
              ? [`expected zero results for facet(s) [${row.facetsUnderTest}], got ${items.length}`]
              : []),
          ];

          await attachFailures(testInfo, failures);
          expect(failures, failures.join('; ')).toEqual([]);
        });
      }
    });
  }
});
