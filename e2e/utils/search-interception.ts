import type { Page } from '@playwright/test';
import type { SearchLandingPage } from '../pages/search-landing.page';

export interface MatchedTerm {
  key: string;
  label: string;
  /** Can be empty — e.g. destination terms on a plain-city query like "paris". */
  value?: string;
  quality: string;
  /** Only present on some rows (seen on the richer "Create a trip..." queries, absent on plain ones). */
  detail?: string;
}

export interface InterpretedQuery {
  destination?: { label: string; localeId: string; localeType: string };
  themes?: string[];
  facets?: Array<{ key: string; label: string; kind: string; weight: string }>;
  minDuration?: number;
  maxDuration?: number;
  /** economy | moderate | premium | luxury | ultra — see PimInterpretedQuery.BudgetTier in the backend. */
  budgetTier?: string;
  /** day-by-day | self-drive | sun-sand | city-breaks — see PimInterpretedQuery.TemplateSlug in the backend. */
  templateSlug?: string;
}

export interface PimSearchResultItem {
  id: string;
  slug: string;
  title: string;
  location: string;
  days: number;
  nights: number;
  matchScore: number;
  matchedTerms?: MatchedTerm[];
  /** day-by-day | self-drive | sun-sand | city-breaks — see PimSearchItem.TemplateSlug in the backend. */
  templateSlug?: string;
  [key: string]: unknown;
}

export interface PimSearchResponseBody {
  items: PimSearchResultItem[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
  interpretedQuery: InterpretedQuery;
  elapsedMs: number;
}

export interface PimSearchRequestPayload {
  query: string;
  page: number;
  pageSize: number;
  sessionId: string;
  [key: string]: unknown;
}

export interface SearchInterception {
  requestPayload: PimSearchRequestPayload;
  responseBody: PimSearchResponseBody;
}

const PIM_SEARCH_PATH = 'pim-itinerary-search';

/**
 * Types a brief into the search landing page, clicks Submit, and races the
 * resulting POST .../pim-itinerary-search request+response against the
 * click so we capture the real outgoing payload and backend response
 * rather than only asserting on the rendered UI. Use this instead of
 * asserting on the DOM alone whenever a test needs to check the exact
 * request shape (e.g. no stray search params leaking in) or
 * interpretedQuery / result accuracy, not just that cards rendered.
 *
 * The response resolving doesn't mean the UI has caught up — /slp -> /srp
 * is a client-side navigation that renders after the response is handled,
 * so this also waits for that navigation before returning, otherwise
 * callers asserting on SearchResultsPage locators can land on the old page.
 */
export async function submitSearchAndIntercept(
  page: Page,
  searchLanding: SearchLandingPage,
  query: string,
): Promise<SearchInterception> {
  await searchLanding.fillBrief(query);

  const [request, response] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(PIM_SEARCH_PATH) && r.method() === 'POST'),
    page.waitForResponse((r) => r.url().includes(PIM_SEARCH_PATH) && r.request().method() === 'POST'),
    searchLanding.submit(),
  ]);

  if (!response.ok()) {
    throw new Error(
      `pim-itinerary-search returned ${response.status()} for query "${query}": ${await response.text()}`,
    );
  }

  const requestPayload = request.postDataJSON() as PimSearchRequestPayload;
  const responseBody = (await response.json()) as PimSearchResponseBody;

  await page.waitForURL(/\/srp\b/, { timeout: 30_000 });

  return { requestPayload, responseBody };
}
