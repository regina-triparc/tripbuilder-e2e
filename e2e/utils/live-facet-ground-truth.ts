import { MongoClient } from 'mongodb';

/**
 * Cheap, aggregate-only ground truth pulled from live PIM inventory —
 * shared by the negative-facet dataset generator (see
 * generate-negative-facet-dataset.ts) so a "budget too high" or "group too
 * big" test row is always set beyond what any real product could satisfy,
 * rather than a guessed magic number that could go stale as inventory
 * changes. Separate from live-inventory.ts's per-country dump (that one
 * needs a detailed per-row aggregation; this one only needs a handful of
 * $max/distinct values), so this opens its own short-lived connection.
 */
export interface LiveFacetGroundTruth {
  /** Distinct `Location.Country.Name` values across marketplace.product-live-search. */
  countries: string[];
  /** First entry of `countries` — a real, known-good destination for isolating the budget/group-size facets. */
  sampleCountry: string;
  /** Highest `Pricing.BaseCost` seen across all live products — any budget above this can't be satisfied. */
  maxBaseCost: number;
  /** Highest `MaxGroupSize` seen across stockroom.products — any requested party size above this can't be satisfied. */
  maxGroupSize: number;
}

export async function fetchLiveFacetGroundTruth(): Promise<LiveFacetGroundTruth | null> {
  const uri = process.env.PIM_MONGODB_URI;
  if (!uri) return null;

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const marketplaceDb = client.db('marketplace');
    const stockroomDb = client.db('stockroom');

    const countries: string[] = await marketplaceDb.collection('product-live-search').distinct('Location.Country.Name');
    console.log(`[live-inventory] distinct countries (${countries.length}):`);
    console.log(countries);

    const [priceAgg] = await marketplaceDb
      .collection('product-live-search')
      .aggregate<{ maxBaseCost: number }>([
        { $group: { _id: null, maxBaseCost: { $max: { $toDouble: '$Pricing.BaseCost' } } } },
      ])
      .toArray();

    const [groupAgg] = await stockroomDb
      .collection('products')
      .aggregate<{ maxGroupSize: number }>([{ $group: { _id: null, maxGroupSize: { $max: '$MaxGroupSize' } } }])
      .toArray();

    return {
      countries,
      sampleCountry: countries[0] ?? '',
      maxBaseCost: priceAgg?.maxBaseCost ?? 0,
      maxGroupSize: groupAgg?.maxGroupSize ?? 0,
    };
  } finally {
    await client.close();
  }
}
