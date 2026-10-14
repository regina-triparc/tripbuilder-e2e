import { test, expect } from '@playwright/test';
import { attachFailures } from '../../helpers/report';
import { TripItineraryPage } from '../../pages/trip-itinerary.page';

/**
 * Hotel service lifecycle on a trip's Itinerary tab (apps/tsp).
 *
 * Scope, and why it is split this way:
 *
 *   READ  the itinerary lists the hotel service, and the read-only detail sheet
 *         renders the HOTEL branch (`sds-hotel-phone`) rather than the ground /
 *         activity / air one. Non-destructive, runs anywhere.
 *   MODIFY availability only. "Modify" hands off to the nested SHOPPING remote in
 *         replace mode, so actually completing a modify is a shopping-picker
 *         test wearing an itinerary hat — see the note at the bottom.
 *   DELETE the one write that stays inside this tab:
 *         DELETE {shopping-management}/trips/{tripId}/services/{id}?expectedVersion=N
 *         Destructive, so it is gated behind TB_HOTEL_DESTRUCTIVE_TRIP_ID and
 *         skips by default.
 *
 * Assertions go through the app's own read API (`{shopping-inquiry}/trips/{id}/itinerary`),
 * not the database. The traveller suite could assert against make-payable's
 * Postgres because we have a connection string for it; the equivalent for
 * shopping-gateway needs its own Key Vault secret
 * (`TripArcShoppingGateway--ConnectionStrings--*`), which QA does not have yet.
 * Reading back through the API is weaker — it cannot see the event stream — but
 * it is honest about what it proves: the service is gone from the read model,
 * not that an integration event was published.
 *
 * REQUIREMENTS
 *   TB_HOTEL_TRIP_ID              a dev trip with at least one hotel service (read-only cases)
 *   TB_HOTEL_DESTRUCTIVE_TRIP_ID  a THROWAWAY trip whose hotel service may be deleted
 *   a live session — `npm run e2e:auth-manual` (MFA) or `npm run e2e:auth`
 */

const TRIP_ID = process.env.TB_HOTEL_TRIP_ID;
const DESTRUCTIVE_TRIP_ID = process.env.TB_HOTEL_DESTRUCTIVE_TRIP_ID;
/** Matched against the row's visible name; hotel rows are named after the property. */
const HOTEL_NAME = process.env.TB_HOTEL_SERVICE_NAME ?? 'Hotel';

test.describe('hotel service on the itinerary', () => {
  test.skip(!TRIP_ID, 'TB_HOTEL_TRIP_ID is not set — point it at a dev trip that has a hotel service');

  test('the itinerary lists the hotel service with the expected actions', async ({ page }, testInfo) => {
    const itinerary = new TripItineraryPage(page);
    await itinerary.goto(TRIP_ID!);

    const services = await itinerary.services();
    await testInfo.attach('itinerary-services', {
      body: JSON.stringify(services, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];
    const hotel = services.find((service) => service.name.toLowerCase().includes(HOTEL_NAME.toLowerCase()));

    if (!hotel) {
      failures.push(
        `ui: no itinerary row matching "${HOTEL_NAME}". Rows present: ` +
          `${services.map((service) => service.name).join(' | ') || '(none)'}`,
      );
    } else {
      // Both pills must be actionable on a hotel: hotel has a shoppable
      // equivalent, so canReplace() is true for it (unlike Dining).
      if (!hotel.modifyEnabled) failures.push(`ui: Modify is disabled on hotel row "${hotel.name}"`);
      if (!hotel.deleteEnabled) failures.push(`ui: Delete is disabled on hotel row "${hotel.name}"`);
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('the detail sheet renders the hotel branch, not another service type', async ({ page }, testInfo) => {
    const itinerary = new TripItineraryPage(page);
    await itinerary.goto(TRIP_ID!);

    await itinerary.openServiceDetail(HOTEL_NAME);
    const fields = await itinerary.serviceDetailFields();
    await testInfo.attach('detail-sheet-fields', {
      body: JSON.stringify(fields, null, 2),
      contentType: 'application/json',
    });
    await itinerary.closeServiceDetail();

    const failures: string[] = [];
    // `sds-hotel-phone` exists only in the hotel branch of the sheet template,
    // so its presence is what distinguishes "the hotel sheet rendered" from
    // "a sheet rendered". Its VALUE may legitimately be blank.
    if (fields.hotelPhone === undefined) {
      failures.push(
        'ui: the detail sheet did not render sds-hotel-phone — either the sheet opened on a ' +
          'non-hotel service, or the hotel branch regressed',
      );
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('the flat Services view lists the same hotel service as the day view', async ({ page }, testInfo) => {
    const itinerary = new TripItineraryPage(page);
    await itinerary.goto(TRIP_ID!);

    const dayView = await itinerary.services();
    await itinerary.showServicesView();
    const servicesView = await itinerary.services();

    await testInfo.attach('day-vs-services-view', {
      body: JSON.stringify({ dayView: dayView.map((s) => s.name), servicesView: servicesView.map((s) => s.name) }, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];
    // The two views are separate renders of one dataset, grouped differently —
    // a service present in one and missing from the other is a real defect and
    // the kind of thing only a cross-view check catches.
    const missing = dayView.filter((service) => !servicesView.some((other) => other.name === service.name));
    if (missing.length > 0) {
      failures.push(`ui: services in the day view but absent from the Services view: ${missing.map((s) => s.name).join(', ')}`);
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  /**
   * DESTRUCTIVE. Deletes a hotel service and asserts it is gone from the
   * shopping-inquiry read model, not merely from the DOM — a row can disappear
   * optimistically while the write fails behind it.
   */
  test('deleting a hotel service removes it from the itinerary read model', async ({ page }, testInfo) => {
    test.skip(
      !DESTRUCTIVE_TRIP_ID,
      'TB_HOTEL_DESTRUCTIVE_TRIP_ID is not set — this test deletes a hotel service, so it needs a throwaway trip',
    );
    test.setTimeout(180_000);

    const itinerary = new TripItineraryPage(page);
    await itinerary.goto(DESTRUCTIVE_TRIP_ID!);

    const before = await itinerary.services();
    const call = await itinerary.deleteServiceByName(HOTEL_NAME);
    await testInfo.attach('delete-call', {
      body: JSON.stringify({ ...call, servicesBefore: before.map((s) => s.name) }, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];
    if (![200, 202, 204].includes(call.status)) {
      failures.push(`ui: ${call.method} ${call.url} returned ${call.status}`);
    }
    // expectedVersion is how this write does optimistic concurrency; a missing
    // one means the version cache never seeded and the write is one 409 away
    // from failing for the next person.
    if (!call.expectedVersion) {
      failures.push(`ui: delete was sent without an expectedVersion query parameter: ${call.url}`);
    }
    if (!call.serviceId) {
      failures.push(`ui: could not recover a travelServiceId from ${call.url}`);
    }

    // Read back through the app's own API — the authoritative check.
    const itineraryRead = await page.request.get(
      `/bff/api/shopping-inquiry/trips/${DESTRUCTIVE_TRIP_ID}/itinerary`,
      { headers: { 'X-Csrf': '1' } },
    );
    const body = await itineraryRead.text();
    await testInfo.attach('itinerary-read-after-delete', { body, contentType: 'application/json' });

    if (!itineraryRead.ok()) {
      failures.push(`api: itinerary read returned ${itineraryRead.status()} after the delete`);
    } else if (call.serviceId && body.includes(call.serviceId)) {
      failures.push(
        `api: service ${call.serviceId} still appears in the itinerary read model after a ${call.status} delete`,
      );
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

/**
 * NOT COVERED YET — add and modify.
 *
 * Both hand off to the nested shopping remote (`requestOpenShopping`), so
 * covering them means driving the hotel picker: search, room/rate selection,
 * then add-or-replace. That is a shopping-surface suite with its own page
 * object, and it belongs beside this file (e2e/services/hotel/) rather than
 * inside it, so a picker failure is never reported as an itinerary failure.
 *
 * When it is written, the strongest assertion available is the same read-back
 * used above plus shopping-gateway's own event stream — which needs the
 * `TripArcShoppingGateway--ConnectionStrings--*` Key Vault secret that QA does
 * not currently have. Worth requesting alongside it.
 */
