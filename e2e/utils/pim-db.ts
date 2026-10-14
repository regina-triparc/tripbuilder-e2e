import { MongoClient, ObjectId, type Document } from 'mongodb';

/**
 * Direct read access to the PIM `stockroom.products` collection — used to
 * assert search results against DB ground truth (not just API-shape
 * checks), e.g. "is this result actually channel-enabled and not
 * soft-deleted, and does the API's duration match the source document."
 *
 * Only reachable over the corporate VPN (Atlas PrivateLink — see
 * PIM_MONGODB_URI in .env.example), so every consumer must check
 * isPimDbConfigured() first and skip gracefully when it's unset. This
 * keeps the suite runnable in CI/off-VPN with API-only coverage, while
 * still giving on-VPN runs the extra DB-level assertions.
 */

const DB_NAME = 'stockroom';
const COLLECTION_NAME = 'products';
const MARKETPLACE_DB_NAME = 'marketplace';
const LIVE_SEARCH_COLLECTION_NAME = 'product-live-search';

let client: MongoClient | undefined;

export function isPimDbConfigured(): boolean {
  return Boolean(process.env.PIM_MONGODB_URI);
}

async function getClient(): Promise<MongoClient> {
  if (!client) {
    const uri = process.env.PIM_MONGODB_URI;
    if (!uri) {
      throw new Error('PIM_MONGODB_URI is not set — call isPimDbConfigured() before using this helper.');
    }
    client = new MongoClient(uri);
    await client.connect();
  }
  return client;
}

/** Call once from Playwright globalTeardown so the process can exit cleanly. */
export async function closePimDbConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
  }
}

export interface PimProductDocument extends Document {
  _id: ObjectId;
  InternalName: string;
  DateDeleted: Date | null;
  IsMultiDay: boolean;
  ChannelAssignments?: Array<{ ChannelSlug: string; IsEnabled: boolean }>;
  ItinerarySchedule?: { ItineraryDays?: Array<{ DayNumber: number }> };
}

interface LocaleNode {
  Name: string;
  Slug: string;
  LocaleType: string;
}

/** Shape of marketplace.product-live-search — the collection the search index itself reads from. */
export interface ProductLiveSearchDocument extends Document {
  _id: ObjectId;
  SkuId: string;
  DurationDays: number;
  DateDeleted: Date | null;
  Location: {
    Continent?: LocaleNode;
    Country?: LocaleNode;
    Region?: LocaleNode;
    City?: LocaleNode;
    PrimaryLocation?: LocaleNode;
  };
  TemplateType?: { Type: string; Slug: string; Name: string };
  Pricing?: { Currency: string };
}

/** Returns null both when the id is malformed and when no matching document exists. */
export async function findProductById(id: string): Promise<PimProductDocument | null> {
  if (!ObjectId.isValid(id)) return null;
  const mongoClient = await getClient();
  const collection = mongoClient.db(DB_NAME).collection<PimProductDocument>(COLLECTION_NAME);
  return collection.findOne({ _id: new ObjectId(id) });
}

/** Returns null both when the id is malformed and when no matching document exists. */
export async function findLiveSearchDocById(id: string): Promise<ProductLiveSearchDocument | null> {
  if (!ObjectId.isValid(id)) return null;
  const mongoClient = await getClient();
  const collection = mongoClient.db(MARKETPLACE_DB_NAME).collection<ProductLiveSearchDocument>(LIVE_SEARCH_COLLECTION_NAME);
  return collection.findOne({ _id: new ObjectId(id) });
}

/** A template slug is singular in marketplace.product-live-search ("city-break") but plural in the API's enum ("city-breaks") — normalize before comparing. */
function normalizeTemplateSlug(slug: string): string {
  return slug.toLowerCase().replace(/s$/, '');
}

/**
 * DB-level ground truth for a search result item against the collection the
 * search index itself reads from (marketplace.product-live-search) — as
 * opposed to assertProductBackedBySearchItem's stockroom.products check,
 * which verifies booking/channel eligibility rather than search-facing
 * content. Cross-checks the id the API returned actually resolves to a
 * live document whose destination, duration, and template line up with
 * both what the API echoed back and what the CSV row expects.
 */
export async function assertLiveSearchDocBacksItem(
  item: { id: string; title: string; days: number; templateSlug?: string },
  row: { expectedDestinationLabel: string },
): Promise<string[]> {
  const failures: string[] = [];
  const doc = await findLiveSearchDocById(item.id);

  if (!doc) {
    failures.push(`db: no product found in marketplace.product-live-search for search result id "${item.id}" ("${item.title}")`);
    return failures;
  }
  if (doc.DateDeleted) {
    failures.push(`db: live-search doc "${item.id}" is soft-deleted (DateDeleted set) but was returned by search`);
  }
  if (doc.DurationDays !== item.days) {
    failures.push(`db: live-search doc "${item.id}" has DurationDays=${doc.DurationDays}, search returned days=${item.days}`);
  }
  if (item.templateSlug && doc.TemplateType?.Slug && normalizeTemplateSlug(doc.TemplateType.Slug) !== normalizeTemplateSlug(item.templateSlug)) {
    failures.push(`db: live-search doc "${item.id}" TemplateType.Slug="${doc.TemplateType.Slug}" does not match search item templateSlug="${item.templateSlug}"`);
  }
  if (row.expectedDestinationLabel) {
    const locationNames = [doc.Location?.Country?.Name, doc.Location?.Region?.Name, doc.Location?.City?.Name].filter(
      (name): name is string => Boolean(name),
    );
    if (!locationNames.includes(row.expectedDestinationLabel)) {
      failures.push(
        `db: live-search doc "${item.id}" Location (Country="${doc.Location?.Country?.Name}", Region="${doc.Location?.Region?.Name}", ` +
          `City="${doc.Location?.City?.Name}") does not include expected destination "${row.expectedDestinationLabel}"`,
      );
    }
  }

  return failures;
}

/**
 * DB-level ground truth for a search result item: it should resolve to a
 * live (non-deleted), channel-enabled product whose actual day count
 * agrees with what the search API returned. Mirrors the CSV-driven
 * failures[] pattern used by utils/search-assertions.ts.
 */
export async function assertProductBackedBySearchItem(
  item: { id: string; title: string; days: number },
  /**
   * The channel slug TripBuilder's search is scoped to, if known — pass
   * undefined to only check "some channel is enabled" rather than a
   * specific one. Products live under different brands (Kensington, KT
   * Vacations, etc.) with different slugs, so don't assume a single
   * hardcoded slug applies to every result.
   */
  channelSlug?: string,
): Promise<string[]> {
  const failures: string[] = [];
  const product = await findProductById(item.id);

  if (!product) {
    failures.push(`db: no product found in stockroom.products for search result id "${item.id}" ("${item.title}")`);
    return failures;
  }
  if (product.DateDeleted) {
    failures.push(`db: product "${item.id}" is soft-deleted (DateDeleted set) but was returned by search`);
  }
  const enabled = channelSlug
    ? (product.ChannelAssignments ?? []).some((c) => c.ChannelSlug === channelSlug && c.IsEnabled)
    : (product.ChannelAssignments ?? []).some((c) => c.IsEnabled);
  if (!enabled) {
    const scope = channelSlug ? `for channel "${channelSlug}"` : 'for any channel';
    failures.push(`db: product "${item.id}" has no enabled ChannelAssignment ${scope}`);
  }
  const dbDayCount = product.ItinerarySchedule?.ItineraryDays?.length ?? 0;
  if (dbDayCount > 0 && dbDayCount !== item.days) {
    failures.push(`db: product "${item.id}" has ${dbDayCount} ItinerarySchedule day(s), search returned days=${item.days}`);
  }

  return failures;
}
