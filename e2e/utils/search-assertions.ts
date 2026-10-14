import type { InterpretedQuery, PimSearchRequestPayload, PimSearchResultItem } from './search-interception';

/**
 * Fields shared by every NL-search dataset row (ui and api fixtures both
 * carry these columns). Row-specific extras (e.g. api's mustNotIncludeCity)
 * extend this in their own spec.
 */
export interface NlSearchExpectations {
  query: string;
  expectedDestinationLabel: string;
  expectedLocaleType: string;
  expectedMinDuration: string;
  expectedMaxDuration: string;
  expectedBudgetTier: string;
  /** day-by-day | self-drive | sun-sand | city-breaks — PimInterpretedQuery.TemplateSlug. Leave blank when no travel-style preference is implied. */
  expectedTemplateSlug: string;
  expectedFacetKeys: string;
  /**
   * Regression guard for word-substring destination mismatches — e.g. the
   * word "trip" in "create a trip..." getting fuzzy-matched to the city
   * "Tripoli" and silently zeroing out results. Leave blank when not
   * testing a specific known-bad label.
   */
  mustNotMatchDestinationLabel: string;
}

/**
 * Authoritative enums from services/trip-agents/TripArc.TripAgents.Shared/Responses/PimSearch/PimSearchResponse.cs
 * (mirrored in services/tripbuilder-api's copy of the same file). Keep these in sync with that file, not
 * with whatever values happen to show up in a sample response — sample responses can themselves be
 * emitting an out-of-range value, which is exactly the kind of regression this assertion exists to catch.
 */
export const VALID_BUDGET_TIERS = ['economy', 'moderate', 'premium', 'luxury', 'ultra'];
export const VALID_TEMPLATE_SLUGS = ['day-by-day', 'self-drive', 'sun-sand', 'city-breaks'];
export const VALID_MATCHED_TERM_QUALITIES = ['match', 'partial', 'mismatch'];
export const VALID_FACET_WEIGHTS = ['optional', 'preferred', 'must-have'];

const DURATION_TOLERANCE_DAYS = 2;

/** interpretedQuery.destination/duration/budgetTier/facets accuracy — used by both the UI and API suites. */
export function assertInterpretedQuery(interpreted: InterpretedQuery, row: NlSearchExpectations): string[] {
  const failures: string[] = [];

  if (row.expectedDestinationLabel && interpreted.destination?.label !== row.expectedDestinationLabel) {
    failures.push(
      `destination label: expected "${row.expectedDestinationLabel}", got "${interpreted.destination?.label}"`,
    );
  }
  if (row.expectedLocaleType && interpreted.destination?.localeType !== row.expectedLocaleType) {
    failures.push(`localeType: expected "${row.expectedLocaleType}", got "${interpreted.destination?.localeType}"`);
  }
  if (row.expectedMinDuration) {
    const got = Number(interpreted.minDuration);
    const expected = Number(row.expectedMinDuration);
    if (!Number.isFinite(got) || Math.abs(got - expected) > DURATION_TOLERANCE_DAYS) {
      failures.push(`minDuration: expected ~${expected}, got ${interpreted.minDuration}`);
    }
  }
  if (row.expectedMaxDuration) {
    const got = Number(interpreted.maxDuration);
    const expected = Number(row.expectedMaxDuration);
    if (!Number.isFinite(got) || Math.abs(got - expected) > DURATION_TOLERANCE_DAYS) {
      failures.push(`maxDuration: expected ~${expected}, got ${interpreted.maxDuration}`);
    }
  }
  if (row.expectedBudgetTier && interpreted.budgetTier !== row.expectedBudgetTier) {
    failures.push(`budgetTier: expected "${row.expectedBudgetTier}", got "${interpreted.budgetTier}"`);
  }
  if (row.expectedTemplateSlug && interpreted.templateSlug !== row.expectedTemplateSlug) {
    failures.push(`templateSlug: expected "${row.expectedTemplateSlug}", got "${interpreted.templateSlug}"`);
  }
  if (row.expectedFacetKeys) {
    const expectedKeys = row.expectedFacetKeys.split('|').map((k) => k.trim());
    const gotKeys = (interpreted.facets ?? []).map((f) => f.key);
    const missing = expectedKeys.filter((k) => !gotKeys.includes(k));
    if (missing.length > 0) {
      failures.push(`facets: missing expected key(s) [${missing.join(', ')}], got [${gotKeys.join(', ')}]`);
    }
  }
  if (row.mustNotMatchDestinationLabel && interpreted.destination?.label === row.mustNotMatchDestinationLabel) {
    failures.push(
      `destination label incorrectly matched "${row.mustNotMatchDestinationLabel}" — likely a word-substring ` +
        `false match (e.g. "trip" -> "Tripoli") rather than real destination intent`,
    );
  }

  return failures;
}

/**
 * Result-set-level check that the actual returned items — not just the
 * parsed interpretedQuery — line up with what the NL query asked for. A
 * model can parse a query correctly (interpretedQuery matches) while the
 * underlying search still surfaces mismatched inventory, or vice versa;
 * assertInterpretedQuery only covers the former, so this covers the top
 * result's destination/duration/template against the same CSV row.
 */
export function assertItemsMatchQuery(items: PimSearchResultItem[], row: NlSearchExpectations): string[] {
  const failures: string[] = [];
  if (items.length === 0) return failures;

  const topItem = [...items].sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))[0];

  if (
    row.expectedDestinationLabel &&
    !String(topItem.location ?? '').toLowerCase().includes(row.expectedDestinationLabel.toLowerCase())
  ) {
    failures.push(
      `top item "${topItem.title}" location "${topItem.location}" does not include expected destination "${row.expectedDestinationLabel}"`,
    );
  }

  if (row.expectedMinDuration || row.expectedMaxDuration) {
    const min = row.expectedMinDuration ? Number(row.expectedMinDuration) : -Infinity;
    const max = row.expectedMaxDuration ? Number(row.expectedMaxDuration) : Infinity;
    if (topItem.days < min - DURATION_TOLERANCE_DAYS || topItem.days > max + DURATION_TOLERANCE_DAYS) {
      failures.push(
        `top item "${topItem.title}" days=${topItem.days} is outside expected range ` +
          `[${row.expectedMinDuration || '-'}, ${row.expectedMaxDuration || '-'}] (±${DURATION_TOLERANCE_DAYS})`,
      );
    }
  }

  if (row.expectedTemplateSlug && topItem.templateSlug && topItem.templateSlug !== row.expectedTemplateSlug) {
    failures.push(
      `top item "${topItem.title}" templateSlug "${topItem.templateSlug}" does not match expected "${row.expectedTemplateSlug}"`,
    );
  }

  return failures;
}

/** A query for one city must not surface a different, unlabeled city as its top-ranked result. */
export function assertMustNotIncludeCity(items: PimSearchResultItem[], mustNotIncludeCity: string): string[] {
  if (!mustNotIncludeCity) return [];

  const offenders = items.filter((it) => String(it.location ?? '').includes(mustNotIncludeCity));
  const ranked = [...items].sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  const top = ranked[0];

  return offenders.length > 0 && top && offenders.includes(top)
    ? [`unlabeled mismatch city "${mustNotIncludeCity}" ranked as top result`]
    : [];
}

/**
 * Backend enum conformance — runs on EVERY row regardless of what that row's dataset columns
 * expect, since a value outside the declared enum is a bug no matter what query produced it
 * (e.g. an emitted budgetTier of "budget" instead of "economy", or a templateSlug the FE's
 * Travel Style facet doesn't know how to render). See VALID_* constants above for the source.
 */
export function assertResponseEnumsValid(interpreted: InterpretedQuery, items: PimSearchResultItem[]): string[] {
  const failures: string[] = [];

  if (interpreted.budgetTier && !VALID_BUDGET_TIERS.includes(interpreted.budgetTier)) {
    failures.push(`budgetTier "${interpreted.budgetTier}" is not a valid tier (${VALID_BUDGET_TIERS.join(' | ')})`);
  }
  if (interpreted.templateSlug && !VALID_TEMPLATE_SLUGS.includes(interpreted.templateSlug)) {
    failures.push(`templateSlug "${interpreted.templateSlug}" is not a valid slug (${VALID_TEMPLATE_SLUGS.join(' | ')})`);
  }
  for (const facet of interpreted.facets ?? []) {
    if (facet.weight && !VALID_FACET_WEIGHTS.includes(facet.weight)) {
      failures.push(`facet "${facet.key}" weight "${facet.weight}" is not valid (${VALID_FACET_WEIGHTS.join(' | ')})`);
    }
  }
  for (const item of items) {
    if (item.templateSlug && !VALID_TEMPLATE_SLUGS.includes(item.templateSlug)) {
      failures.push(
        `item "${item.title}" templateSlug "${item.templateSlug}" is not a valid slug (${VALID_TEMPLATE_SLUGS.join(' | ')})`,
      );
    }
    for (const term of item.matchedTerms ?? []) {
      if (term.quality && !VALID_MATCHED_TERM_QUALITIES.includes(term.quality)) {
        failures.push(
          `item "${item.title}" matchedTerm "${term.key}" quality "${term.quality}" is not valid ` +
            `(${VALID_MATCHED_TERM_QUALITIES.join(' | ')})`,
        );
      }
    }
  }

  return failures;
}

const EXPECTED_REQUEST_KEYS = ['query', 'page', 'pageSize', 'sessionId'].sort();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UI-only: the outgoing request must be exactly what the user typed — no
 * stray search params (filters, pagination overrides, etc.) leaking into
 * the payload beyond the four fields the search box itself controls.
 */
export function assertRequestPayloadShape(requestPayload: PimSearchRequestPayload, expectedQuery: string): string[] {
  const failures: string[] = [];
  const gotKeys = Object.keys(requestPayload).sort();

  if (JSON.stringify(gotKeys) !== JSON.stringify(EXPECTED_REQUEST_KEYS)) {
    failures.push(`request keys: expected [${EXPECTED_REQUEST_KEYS}], got [${gotKeys}]`);
  }
  if (requestPayload.query !== expectedQuery) {
    failures.push(`request query: expected "${expectedQuery}", got "${requestPayload.query}"`);
  }
  if (requestPayload.page !== 1) {
    failures.push(`request page: expected 1, got ${requestPayload.page}`);
  }
  if (requestPayload.pageSize !== 20) {
    failures.push(`request pageSize: expected 20, got ${requestPayload.pageSize}`);
  }
  if (!UUID_RE.test(requestPayload.sessionId)) {
    failures.push(`request sessionId: "${requestPayload.sessionId}" is not a UUID`);
  }

  return failures;
}
