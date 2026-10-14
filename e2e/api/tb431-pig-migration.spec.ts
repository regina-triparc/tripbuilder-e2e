import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * TB-431 — "Migrate PIM to PIG gateway" — DEV acceptance probes.
 *
 * Everything the ticket's status comment claims that can be observed from outside the
 * cluster, through the portal BFF, with an advisor session. Deliberately NOT data-driven
 * like the sibling `pim-itinerary-search-*.spec.ts` files: those grade the agent's
 * interpretation of a query, while this file only asks "is the thing behind the route PIG,
 * and are the PIM doors shut". A ranking regression must not read as a migration failure.
 *
 * BFF prefixes come from `services/tripbuilder-bff/.../appsettings.json` ReverseProxy routes.
 */

const SEARCH_NEW = 'tripagents/chat/product-search';
const SEARCH_ALIAS = 'tripagents/chat/pim-itinerary-search';
// The BFF strips its own prefix and re-adds `/api` itself (`PathRemovePrefix` + `PathPrefix`
// in appsettings.json), so these carry NO `api/` segment — writing one produces `/api/api/...`
// upstream, which 404s for the wrong reason and turns every "the route is gone" assertion
// below into a vacuous pass. Each describe block opens with a control probe for that reason.
const SG = 'shopping-orchestration';
const MONOLITH = 'tripbuilder';

const JSON_HEADERS = { 'x-csrf': '1', 'Content-Type': 'application/json' };

/** PIG keys products by a Mongo ObjectId; a slug is lowercase words and dashes. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

type SearchItem = { id?: string; slug?: string; title?: string };
type SearchResponse = { items?: SearchItem[]; error?: string; pagination?: { total?: number } };

function searchBody(query: string) {
  return { query, page: 1, pageSize: 20, sessionId: randomUUID() };
}

test.describe('TB-431 — product discovery runs on PIG', () => {
  test('product-search answers 200 with items', async ({ request }, testInfo) => {
    const response = await request.post(SEARCH_NEW, { headers: JSON_HEADERS, data: searchBody('Italy') });
    const text = await response.text();
    await testInfo.attach('product-search', { body: `status ${response.status()}\n\n${text}`, contentType: 'text/plain' });

    expect(response.status(), `POST ${SEARCH_NEW} -> ${response.status()}`).toBe(200);
    const body = JSON.parse(text) as SearchResponse;
    expect(body.error ?? null, 'agent reported an error').toBeNull();
    expect((body.items ?? []).length, 'product-search returned zero items').toBeGreaterThan(0);
  });

  test('the pim-itinerary-search alias still answers (one-release compatibility)', async ({ request }, testInfo) => {
    const response = await request.post(SEARCH_ALIAS, { headers: JSON_HEADERS, data: searchBody('Italy') });
    const text = await response.text();
    await testInfo.attach('alias', { body: `status ${response.status()}\n\n${text}`, contentType: 'text/plain' });

    expect(response.status(), `POST ${SEARCH_ALIAS} -> ${response.status()} (an old FE build in a browser depends on this)`).toBe(200);
    expect(((JSON.parse(text) as SearchResponse).items ?? []).length).toBeGreaterThan(0);
  });

  test('every result carries a PIG productId, not a slug', async ({ request }, testInfo) => {
    const response = await request.post(SEARCH_NEW, { headers: JSON_HEADERS, data: searchBody('Italy') });
    expect(response.status()).toBe(200);
    const items = ((await response.json()) as SearchResponse).items ?? [];
    expect(items.length).toBeGreaterThan(0);

    // Ruling R-E: `/pdp?productId=` is the only handle the PDP opens on, and the SRP card
    // forwards whatever `id` the agent returned. An id that is a slug is a dead card.
    const bad = items.filter((i) => !OBJECT_ID.test(i.id ?? ''));
    await testInfo.attach('ids', { body: JSON.stringify(items.map((i) => ({ id: i.id, slug: i.slug, title: i.title })), null, 2), contentType: 'application/json' });
    expect(bad.map((i) => `${i.title}: id="${i.id}"`), 'result ids that are not PIG ObjectIds').toEqual([]);
  });
});

test.describe('TB-431 — the PDP reads shopping-gateway, keyed by productId', () => {
  test('control: the shopping-gateway prefix reaches a live route', async ({ request }) => {
    // POST with no body: a 400/415/422 proves the request reached the orchestration app and
    // was rejected by it. Only a 404 here would mean the prefix is wrong, which would make
    // the "slug door is gone" assertion below meaningless.
    const response = await request.post(`${SG}/package-quotes`, { headers: JSON_HEADERS, data: {} });
    expect(response.status(), 'shopping-orchestration prefix does not reach the app').not.toBe(404);
  });

  test('GET /api/products/{productId} returns the product the search handed out', async ({ request }, testInfo) => {
    const search = await request.post(SEARCH_NEW, { headers: JSON_HEADERS, data: searchBody('Italy') });
    expect(search.status()).toBe(200);
    const first = (((await search.json()) as SearchResponse).items ?? [])[0];
    expect(first?.id, 'no search result to resolve').toBeTruthy();

    const detail = await request.get(`${SG}/products/${first!.id}`, { headers: { 'x-csrf': '1' } });
    const text = await detail.text();
    await testInfo.attach('product-detail', { body: `GET ${SG}/products/${first!.id}\nstatus ${detail.status()}\n\n${text.slice(0, 4000)}`, contentType: 'text/plain' });

    expect(detail.status(), `product detail for ${first!.id}`).toBe(200);
    expect(text.toLowerCase()).toContain((first!.id ?? '').toLowerCase());
  });

  test('the slug query door on /api/products is gone', async ({ request }, testInfo) => {
    // Task 15 deleted `MapGet("/api/products", …)`. If this answers 200 the slug-keyed
    // read path is back, which is the silent fallback the migration plan forbids.
    const response = await request.get(`${SG}/products?slug=rome-luxe-6day-culture`, { headers: { 'x-csrf': '1' } });
    await testInfo.attach('slug-door', { body: `status ${response.status()}\n\n${(await response.text()).slice(0, 2000)}`, contentType: 'text/plain' });
    expect(response.status(), 'the slug list/query door answered').not.toBe(200);
  });
});

test.describe('TB-431 — catalogue census', () => {
  // Ruling R-A: the published PIG catalogue IS the catalogue. This does not assert a count —
  // PB can publish more at any time and that must not turn the suite red — it asserts the
  // property that matters to an advisor: every product discovery hands out can be opened.
  // The count it prints is the number to compare against reconcile.sh's PIG side.
  test('every product the agent can surface resolves on the PDP read route', async ({ request }, testInfo) => {
    // Eight LLM-backed searches (~10s each on DEV) plus one detail read per
    // distinct product does not fit the config's 60s default — it fitted in
    // Oct 2026 and stopped fitting as agent latency grew. A timeout here is
    // the harness running out of clock, which must never be read as the
    // census failing, so the budget is stated per-case rather than tuned
    // globally for every other row.
    test.setTimeout(300_000);

    const queries = ['Italy', 'beach', 'family', 'adventure', 'luxury', 'city break', 'Canada', 'Caribbean'];
    const seen = new Map<string, string>();

    for (const query of queries) {
      const response = await request.post(SEARCH_NEW, { headers: JSON_HEADERS, data: searchBody(query) });
      if (response.status() !== 200) continue;
      for (const item of ((await response.json()) as SearchResponse).items ?? []) {
        if (item.id) seen.set(item.id, item.title ?? '');
      }
    }

    const unresolvable: string[] = [];
    for (const [id, title] of seen) {
      const detail = await request.get(`${SG}/products/${id}`, { headers: { 'x-csrf': '1' } });
      if (detail.status() !== 200) unresolvable.push(`${id} (${title}) -> ${detail.status()}`);
    }

    await testInfo.attach('catalogue', {
      body: `${seen.size} distinct product(s) surfaced across ${queries.length} queries\n\n` +
        [...seen].map(([id, title]) => `${id}  ${title}`).join('\n'),
      contentType: 'text/plain',
    });
    expect(unresolvable, 'products discovery surfaced that the PDP cannot open').toEqual([]);
    expect(seen.size, 'discovery surfaced no products at all').toBeGreaterThan(0);
  });
});

test.describe('TB-431 — the monolith PIM pass-throughs are deleted', () => {
  test('control: the monolith prefix reaches a live route', async ({ request }) => {
    // `/api/client-profiles/search` survives the 2026-07 clean-slate sweep, so anything but a
    // 404 here proves the prefix is right and the 404s below are the routes' own absence.
    const response = await request.get(`${MONOLITH}/client-profiles/search`, { headers: { 'x-csrf': '1' } });
    expect(response.status(), 'tripbuilder prefix does not reach the monolith').not.toBe(404);
  });

  for (const route of ['chat/pim-distribute', 'chat/pim-bill-of-services']) {
    test(`POST /api/${route} is 404`, async ({ request }, testInfo) => {
      const response = await request.post(`${MONOLITH}/${route}`, { headers: JSON_HEADERS, data: { slug: 'anything' } });
      await testInfo.attach(route, { body: `status ${response.status()}\n\n${(await response.text()).slice(0, 1000)}`, contentType: 'text/plain' });
      // 404 is the pin. A 401/403 would mean the probe never reached the monolith and the
      // route's absence was never actually observed, so it is not accepted as a pass.
      expect(response.status(), `POST /api/${route} should be gone`).toBe(404);
    });
  }
});
