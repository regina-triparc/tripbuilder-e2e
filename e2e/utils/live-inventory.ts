import { MongoClient, type Document } from 'mongodb';
import { writeCsvFixture } from '../helpers/csv';

/**
 * Regenerates fixtures/live-inventory-dataset.csv from live PIM inventory —
 * run as Playwright's globalSetup (see playwright.config.ts) so every
 * `npm run e2e` invocation starts from a fresh snapshot rather than a
 * hand-maintained/stale CSV. Mirrors utils/pim-db.ts's "skip gracefully
 * off-VPN" convention: PIM_MONGODB_URI is only reachable over the
 * corporate VPN (Atlas PrivateLink), so this is a no-op — not a failure —
 * when it's unset, leaving whatever CSV is already on disk in place.
 *
 * Runs its own MongoClient rather than reusing pim-db.ts's module-level
 * singleton: Playwright executes globalSetup in a separate Node process
 * from the test workers, so that singleton wouldn't be reachable here
 * anyway.
 *
 * Query shape (distinct countries -> per-country flat read -> manual
 * cross-database merge with stockroom.products) mirrors an approved
 * mongosh script; native $lookup can't span databases, so the
 * stockroom-side MinGroupSize/MaxGroupSize merge is done in JS.
 */

const CSV_COLUMNS = [
  'id',
  'DurationDays',
  'Theme',
  'Style',
  'HotelRating',
  'TravelStyle',
  'Services',
  'Pricing',
  'Currency',
  'MinGroupSize',
  'MaxGroupSize',
  'IsFeatured',
  'Rank',
];

interface FlatReadDoc extends Document {
  _id: unknown;
  DurationDays?: number;
  HotelRating?: number;
  IsFeatured?: boolean;
  Rank?: number;
  Style?: string[];
  Services?: string[];
  Theme?: string;
  TravelStyle?: string;
  BaseCost?: number;
  Currency?: string;
}

export async function generateLiveInventoryDataset(): Promise<void> {
  const uri = process.env.PIM_MONGODB_URI;
  if (!uri) {
    console.warn('[live-inventory] PIM_MONGODB_URI not set — skipping live inventory refresh (VPN required), keeping existing fixture on disk.');
    return;
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const marketplaceDb = client.db('marketplace');
    const stockroomDb = client.db('stockroom');

    const countries: string[] = await marketplaceDb
      .collection('product-live-search')
      .distinct('Location.Country.Name');
    console.log(`[live-inventory] refreshing raw dataset across ${countries.length} distinct countr${countries.length === 1 ? 'y' : 'ies'}`);

    const rows: Record<string, string | number | boolean | null>[] = [];

    for (const country of countries) {
      const results = await marketplaceDb
        .collection<FlatReadDoc>('product-live-search')
        .aggregate<FlatReadDoc>([
          { $match: { 'Location.Country.Name': country } },
          {
            $project: {
              _id: 1,
              HotelRating: 1,
              IsFeatured: 1,
              Rank: 1,
              DurationDays: 1,
              Style: { $map: { input: '$TravellerExperience', as: 'te', in: '$$te.DisplayName' } },
              Services: { $map: { input: '$Services', as: 's', in: '$$s.DisplayName' } },
              Theme: '$Category.Slug',
              TravelStyle: '$TemplateType.Name',
              BaseCost: { $toDouble: '$Pricing.BaseCost' },
              Currency: '$Pricing.Currency',
            },
          },
        ])
        .toArray();

      if (results.length === 0) continue;

      const productIds = results.map((r) => r._id);
      const stockroomDocs = await stockroomDb
        .collection('products')
        .find({ _id: { $in: productIds } }, { projection: { MinGroupSize: 1, MaxGroupSize: 1 } })
        .toArray();
      const stockroomMap = new Map(stockroomDocs.map((doc) => [String(doc._id), doc]));

      for (const r of results) {
        const match = stockroomMap.get(String(r._id));
        rows.push({
          id: String(r._id),
          DurationDays: r.DurationDays ?? '',
          Theme: r.Theme ?? '',
          Style: (r.Style ?? []).join('|'),
          HotelRating: r.HotelRating ?? '',
          TravelStyle: r.TravelStyle ?? '',
          Services: (r.Services ?? []).join('|'),
          Pricing: r.BaseCost ?? '',
          Currency: r.Currency ?? '',
          MinGroupSize: match?.MinGroupSize ?? '',
          MaxGroupSize: match?.MaxGroupSize ?? '',
          IsFeatured: r.IsFeatured ?? '',
          Rank: r.Rank ?? '',
        });
      }
    }

    writeCsvFixture(__dirname, '../api/fixtures/live-inventory-dataset.csv', CSV_COLUMNS, rows);
    console.log(`[live-inventory] wrote ${rows.length} row(s) to e2e/api/fixtures/live-inventory-dataset.csv`);
  } finally {
    await client.close();
  }
}
