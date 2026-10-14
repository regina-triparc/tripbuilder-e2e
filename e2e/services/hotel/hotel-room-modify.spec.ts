import { test, expect } from '@playwright/test';
import { attachFailures } from '../../helpers/report';
import { TripItineraryPage } from '../../pages/trip-itinerary.page';
import { HotelPickerPage } from '../../pages/hotel-picker.page';

/**
 * Modifying a hotel service's ROOM TYPE from a trip's Itinerary tab.
 *
 * This is the suite `hotel-service-lifecycle.spec.ts` closes by asking for: "covering
 * [modify] means driving the hotel picker: search, room/rate selection, then
 * add-or-replace. That is a shopping-surface suite with its own page object, and it
 * belongs beside this file." It sits in the same `services-hotel` project, so a failure
 * still reads as a hotel-service failure rather than a traveller-event one.
 *
 * THE FLOW, across two federation remotes:
 *
 *   apps/tsp     Itinerary row -> "Modify" -> requestOpenShopping({ mode:'replace' })
 *   apps/hotel   replace banner -> [results ->] "Choose your room" -> select -> commit
 *   SG           PUT {sg}/draft-trips/{tripId}/services/{serviceId}/replace-from-pick
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE EARNS ITS PLACE
 *
 *   1. Modify reaches the picker IN REPLACE MODE. The replace banner is the only
 *      observable proof the serviceId survived the MFE hop; without it the picker would
 *      silently behave as an "add" and produce a duplicate service instead of a swap.
 *   2. The room list distinguishes ROOM TYPE from RATE PLAN. `roomName` is the
 *      classification ("Deluxe King"); `rateName` is the plan ("Online Rate"). The
 *      component's own comment records a prior bug where the plan was rendered as the
 *      room, and `roomName || rateName` is still the fallback — so this is a live
 *      regression surface, not a hypothetical one.
 *   3. Choosing a different room type is LOCAL until committed, and the summary follows
 *      the choice. This is what makes a modify safe to explore: an advisor comparing
 *      rooms must not be writing to the trip on every click.
 *   4. Committing writes `replace-from-pick` and the new room reaches the read model.
 *      DESTRUCTIVE, so it is behind its own env var and skips by default.
 *
 * Assertions stop at the read model, exactly as the sibling delete case does: proving an
 * integration event was published needs the `TripArcShoppingGateway--ConnectionStrings--*`
 * Key Vault secret QA does not have. A green run here does NOT imply event-level coverage.
 *
 * REQUIREMENTS
 *   TB_HOTEL_TRIP_ID         a dev trip with a hotel service (cases 1-3, non-destructive)
 *   TB_HOTEL_MODIFY_TRIP_ID  a THROWAWAY trip whose hotel room may be swapped (case 4)
 *   TB_HOTEL_SERVICE_NAME    row-name fragment to match (default `Hotel`)
 *   a live session — `npm run e2e:auth-manual` (MFA) or `npm run e2e:auth`
 */

const TRIP_ID = process.env.TB_HOTEL_TRIP_ID;
const MODIFY_TRIP_ID = process.env.TB_HOTEL_MODIFY_TRIP_ID;
const HOTEL_NAME = process.env.TB_HOTEL_SERVICE_NAME ?? 'Hotel';

test.describe('modify a hotel service room type', () => {
  test.skip(!TRIP_ID, 'TB_HOTEL_TRIP_ID is not set — point it at a dev trip that has a hotel service');

  test('Modify opens the hotel picker in replace mode, naming the service being replaced', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);

    const itinerary = new TripItineraryPage(page);
    const picker = new HotelPickerPage(page);

    await itinerary.goto(TRIP_ID!);
    await itinerary.openModifyByName(HOTEL_NAME);
    await picker.waitForRoomList(HOTEL_NAME);

    const replacing = await picker.replacingSummary();
    await testInfo.attach('replacing-banner', {
      body: JSON.stringify(replacing, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];
    if (!(await picker.isReplaceMode())) {
      failures.push(
        'ui: the picker opened without the replace banner ([data-replacing-strip]) — Modify did not ' +
          'carry the serviceId across the MFE boundary, so a commit here would ADD a second hotel ' +
          'rather than replace the existing one',
      );
    } else if (!replacing.name) {
      failures.push('ui: the replace banner rendered but named nothing ([data-replacing-name] is empty)');
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('the room list separates room type from rate plan and offers a real choice', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);

    const itinerary = new TripItineraryPage(page);
    const picker = new HotelPickerPage(page);

    await itinerary.goto(TRIP_ID!);
    await itinerary.openModifyByName(HOTEL_NAME);
    await picker.waitForRoomList(HOTEL_NAME);

    const options = await picker.roomOptions();
    await testInfo.attach('room-options', {
      body: JSON.stringify(options, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];

    if (options.length === 0) {
      failures.push(
        'ui: "Choose your room" rendered no room cards. Either the property has no availability for ' +
          "the trip's dates, or the room list regressed — the attached JSON distinguishes them",
      );
    }

    // A modify is only meaningful if there is something else to move TO.
    if (options.length === 1) {
      failures.push(
        `ui: only one room type on offer ("${options[0].roomName ?? options[0].rateName}") — a room-type ` +
          'modify cannot be exercised against this property/date combination. Point ' +
          'TB_HOTEL_TRIP_ID at a trip whose hotel returns several rooms',
      );
    }

    // Every card must name the ROOM, not fall back to the rate plan. `roomName` absent
    // means the template took its `roomName || rateName` fallback, which is the shape of
    // the bug the component comment records.
    const rateOnly = options.filter((option) => !option.roomName && option.rateName);
    if (rateOnly.length > 0) {
      failures.push(
        `ui: ${rateOnly.length} of ${options.length} room cards render a rate plan where the room ` +
          `classification belongs (no [data-room-name]): ${rateOnly.map((o) => o.rateName).join(' | ')}`,
      );
    }

    // Distinct room types, not the same room repeated per rate plan. Duplicated names
    // with differing rate plans is legitimate; a single name across every card is not,
    // because then "room type" is not what the advisor is choosing.
    const names = options.map((option) => option.roomName).filter(Boolean);
    if (names.length > 1 && new Set(names).size === 1) {
      failures.push(
        `ui: every room card shows the same room type ("${names[0]}") — the list is rate plans, not ` +
          'room types, so a room-type modify has nothing to choose between',
      );
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('choosing a different room type updates the summary without writing to the trip', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);

    const itinerary = new TripItineraryPage(page);
    const picker = new HotelPickerPage(page);

    await itinerary.goto(TRIP_ID!);
    await itinerary.openModifyByName(HOTEL_NAME);
    await picker.waitForRoomList(HOTEL_NAME);

    // Any replace-from-pick during this test is a defect: selection must be local.
    const writes: string[] = [];
    page.on('request', (request) => {
      if (/replace-from-pick/i.test(request.url())) writes.push(`${request.method()} ${request.url()}`);
    });

    const options = await picker.roomOptions();
    test.skip(options.length < 2, 'this property returned fewer than two rooms — nothing to switch between');

    // Pick a card that is not already selected, so the assertion is about a CHANGE.
    const targetIndex = options.findIndex((option) => !option.selected);
    const target = options[targetIndex];

    const before = await picker.summary();
    await picker.selectRoomAt(targetIndex);
    const after = await picker.summary();

    await testInfo.attach('summary-before-after', {
      body: JSON.stringify({ target, before, after, writes }, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];

    // The summary names the room the advisor just chose — otherwise they commit blind.
    if (target.roomName && !(after.roomLabel ?? '').includes(target.roomName)) {
      failures.push(
        `ui: selected "${target.roomName}" but the summary label reads "${after.roomLabel ?? '(none)'}"`,
      );
    }

    // A priced room must price the summary. "On request" legitimately has no amount.
    if (!target.onRequest && !after.price) {
      failures.push('ui: a priced room is selected but the summary shows no amount ([data-pdp-price-amount])');
    }

    // The "Select a room to see pricing." hint must clear once one is selected.
    if (after.hint) {
      failures.push(`ui: the summary still shows its empty-state hint after a selection: "${after.hint}"`);
    }

    // Commit only becomes available with a selection — the gate that stops an empty write.
    if (!(await picker.commitEnabled())) {
      failures.push('ui: commit is still disabled after selecting a room');
    }

    // The point of the test: exploring rooms must not mutate the trip.
    if (writes.length > 0) {
      failures.push(
        `ui: selecting a room issued ${writes.length} write(s) before the advisor committed: ${writes.join(', ')}`,
      );
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  /**
   * DESTRUCTIVE. Replaces the hotel's room on a throwaway trip and asserts the swap
   * reached the shopping-inquiry read model — not merely that the modal closed.
   */
  test('committing a room change writes replace-from-pick and lands in the read model', async ({
    page,
  }, testInfo) => {
    test.skip(
      !MODIFY_TRIP_ID,
      'TB_HOTEL_MODIFY_TRIP_ID is not set — this test swaps a hotel room, so it needs a throwaway trip',
    );
    test.setTimeout(240_000);

    const itinerary = new TripItineraryPage(page);
    const picker = new HotelPickerPage(page);

    await itinerary.goto(MODIFY_TRIP_ID!);
    await itinerary.openModifyByName(HOTEL_NAME);
    await picker.waitForRoomList(HOTEL_NAME);

    const options = await picker.roomOptions();
    test.skip(options.length < 2, 'this property returned fewer than two rooms — nothing to switch between');

    const targetIndex = options.findIndex((option) => !option.selected);
    const target = options[targetIndex];
    await picker.selectRoomAt(targetIndex);

    const call = await picker.commitRoomChange();
    await testInfo.attach('replace-from-pick-call', {
      body: JSON.stringify({ target, call }, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];
    if (![200, 201, 202, 204].includes(call.status)) {
      failures.push(`ui: ${call.method} ${call.url} returned ${call.status}`);
    }
    if (!call.serviceId) {
      failures.push(`ui: could not recover a travelServiceId from ${call.url}`);
    }

    // Read back through the app's own API — the authoritative check, and the same one the
    // sibling delete case uses.
    const read = await page.request.get(
      `/bff/api/shopping-inquiry/trips/${MODIFY_TRIP_ID}/itinerary`,
      { headers: { 'X-Csrf': '1' } },
    );
    const body = await read.text();
    await testInfo.attach('itinerary-read-after-modify', { body, contentType: 'application/json' });

    if (!read.ok()) {
      failures.push(`api: itinerary read returned ${read.status()} after the room change`);
    } else if (target.roomName && !body.includes(target.roomName)) {
      // SG replaces the service, so the NEW room's classification should now appear on
      // the trip. Absent, the write was acknowledged but did not take.
      failures.push(
        `api: committed room "${target.roomName}" does not appear in the itinerary read model after a ` +
          `${call.status} replace-from-pick`,
      );
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

/**
 * TIER — deliberately NOT covered here, and not by omission.
 *
 * "Tier" in this product is `Discovery | Premier | Luxe` (`SrpTier`): a colour-coded badge
 * on a PACKAGE result card, read-only metadata with no modify affordance anywhere in the
 * app. Nothing in apps/hotel carries a tier at all — a room has `roomName`, `rateName`,
 * `roomType`, `beddingType` and `boardType`, and no tier.
 *
 * Tier-dependent ROOM SUBSTITUTION is the thing that would be testable, and it is parked:
 * "PDP — Payment Summary Panel — Job Story Breakdown" (Confluence 3526623241) parks story
 * E1 on 11 September 2026 with the substitution rule unsettled, and lists "Tier-dependent
 * substitution rules" as out of scope because they "would need a tier-to-room-category
 * mapping inside Trip Builder, which is a future phase".
 *
 * So there is no tier behaviour to assert without inventing the rule the PRD says is
 * undecided. When that rule lands, it belongs beside this file as its own case.
 */
