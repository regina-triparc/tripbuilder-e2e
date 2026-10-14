import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeCsvFixture } from '../helpers/csv';
import type { LiveFacetGroundTruth } from './live-facet-ground-truth';

/**
 * Regenerates fixtures/pim-search-negative-dataset.csv — the "should
 * return zero results" counterpart to the hand-authored
 * pim-search-positive-dataset.csv (see pim-itinerary-search-negative.spec.ts).
 *
 * Each row isolates one facet that no live product can satisfy, plus one
 * combined case, per the search-e2e README:
 *  - destination: a fictional place name at each DB locale granularity
 *    (Country/Region/City) that can never match real inventory. Continent
 *    is deliberately skipped — there are only 7 real continents, so a
 *    "fake continent" isn't a meaningful natural-language test case.
 *  - budget: a real, known-good destination (`groundTruth.sampleCountry`)
 *    with a budget set above `maxBaseCost` — no product at that price
 *    exists anywhere in live inventory, regardless of destination.
 *  - groupSize: same real destination, party size above `maxGroupSize`.
 *  - budget+groupSize: both of the above combined in one query.
 *
 * Budget/groupSize thresholds are derived from live inventory (not
 * hand-picked constants) so this stays valid as inventory changes —
 * "above the highest price/group size that exists anywhere" is true by
 * construction as long as the ground truth was queried fresh.
 */

interface NegativeDatasetRow {
  id: string;
  category: string;
  query: string;
  expectedDestinationLabel: string;
  expectedLocaleType: string;
  expectedMinDuration: string;
  expectedMaxDuration: string;
  expectedCurrency: string;
  expectedBudgetTier: string;
  expectedTemplateSlug: string;
  expectedFacetKeys: string;
  mustNotMatchDestinationLabel: string;
  mustNotIncludeCity: string;
  facetsUnderTest: string;
  expectedOutcome: string;
  notes: string;
  xrayKey: string;
}

/**
 * Row id -> Xray Test issue key. Kept in a committed JSON file because this
 * CSV is regenerated on every run and gitignored, so a key typed into the
 * CSV itself would not survive. Row ids here are stable and hand-authored
 * below, so the map only needs touching when a facet row is added/removed.
 */
const XRAY_KEYS_FILE = '../api/fixtures/negative-dataset-xray-keys.json';

function loadXrayKeys(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, XRAY_KEYS_FILE), 'utf-8')) as Record<string, string>;
  } catch {
    // Absent or malformed map is not fatal — rows just import unmapped, and
    // the Xray reporter lists them so the gap stays visible.
    console.warn(`[live-inventory] could not read ${XRAY_KEYS_FILE} — negative rows will have no Xray key`);
    return {};
  }
}

const CSV_COLUMNS = [
  'id',
  'category',
  'query',
  'expectedDestinationLabel',
  'expectedLocaleType',
  'expectedMinDuration',
  'expectedMaxDuration',
  'expectedCurrency',
  'expectedBudgetTier',
  'expectedTemplateSlug',
  'expectedFacetKeys',
  'mustNotMatchDestinationLabel',
  'mustNotIncludeCity',
  'facetsUnderTest',
  'expectedOutcome',
  'notes',
  'xrayKey',
];

function row(partial: Partial<NegativeDatasetRow> & Pick<NegativeDatasetRow, 'id' | 'category' | 'query' | 'facetsUnderTest' | 'notes'>): NegativeDatasetRow {
  return {
    expectedDestinationLabel: '',
    expectedLocaleType: '',
    expectedMinDuration: '',
    expectedMaxDuration: '',
    expectedCurrency: '',
    expectedBudgetTier: '',
    expectedTemplateSlug: '',
    expectedFacetKeys: '',
    mustNotMatchDestinationLabel: '',
    mustNotIncludeCity: '',
    expectedOutcome: 'no-results',
    xrayKey: '',
    ...partial,
  };
}

export function generateNegativeFacetDataset(groundTruth: LiveFacetGroundTruth): void {
  const { sampleCountry, maxBaseCost, maxGroupSize } = groundTruth;
  const overBudget = Math.round(maxBaseCost * 10) || 1_000_000;
  const oversizedGroup = maxGroupSize > 0 ? maxGroupSize + 10 : 50;

  const rows: NegativeDatasetRow[] = [
    row({
      id: 'destination-negative-country',
      category: 'destination-facet',
      query: '10 days in Genovia for 2 adults',
      facetsUnderTest: 'destination(country)',
      notes: 'Genovia is a fictional country — no live inventory can exist for it, at any locale granularity.',
    }),
    row({
      id: 'destination-negative-region',
      category: 'destination-facet',
      query: 'a week in New Cascadia for 2 adults',
      facetsUnderTest: 'destination(region)',
      notes: 'New Cascadia is a fictional region/province — tests the sub-country (State) granularity path with no matching inventory.',
    }),
    row({
      id: 'destination-negative-city',
      category: 'destination-facet',
      query: '5 days in San Junipero for 2 adults',
      facetsUnderTest: 'destination(city)',
      notes: 'San Junipero is a fictional city — tests the city (Location) granularity path with no matching inventory.',
    }),
    row({
      id: 'budget-negative',
      category: 'budget-facet',
      query: `10 days in ${sampleCountry} for 2 adults, budget ${overBudget} USD`,
      expectedDestinationLabel: sampleCountry,
      expectedLocaleType: 'Country',
      expectedCurrency: 'USD',
      facetsUnderTest: 'budget',
      notes: `Destination is real (${sampleCountry}) so this isolates the budget facet — ${overBudget} USD is 10x the highest BaseCost (${maxBaseCost}) seen anywhere in live inventory, so no product anywhere can satisfy it.`,
    }),
    row({
      id: 'groupsize-negative',
      category: 'groupsize-facet',
      query: `10 days in ${sampleCountry} for ${oversizedGroup} adults`,
      expectedDestinationLabel: sampleCountry,
      expectedLocaleType: 'Country',
      facetsUnderTest: 'groupSize',
      notes: `Destination is real (${sampleCountry}) so this isolates the groupSize facet — ${oversizedGroup} exceeds the highest MaxGroupSize (${maxGroupSize}) seen anywhere in stockroom.products.`,
    }),
    row({
      id: 'budget-and-groupsize-negative-combo',
      category: 'facet-combination',
      query: `10 days in ${sampleCountry} for ${oversizedGroup} adults, budget ${overBudget} USD`,
      expectedDestinationLabel: sampleCountry,
      expectedLocaleType: 'Country',
      expectedCurrency: 'USD',
      facetsUnderTest: 'budget+groupSize',
      notes: 'Combines both over-threshold facets in one query — destination stays real/valid so this row proves the two negative facets compound rather than masking each other.',
    }),
  ];

  // Merged in after the rows are built so the id->key mapping stays a
  // separate, hand-maintained concern from the live-inventory derivation.
  const xrayKeys = loadXrayKeys();
  for (const r of rows) r.xrayKey = xrayKeys[r.id] ?? '';

  writeCsvFixture(__dirname, '../api/fixtures/pim-search-negative-dataset.csv', CSV_COLUMNS, rows);
  console.log(`[live-inventory] wrote ${rows.length} row(s) to e2e/api/fixtures/pim-search-negative-dataset.csv`);
}
