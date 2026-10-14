import { test, expect, type TestInfo } from '@playwright/test';
import { attachFailures, safeDbCheck } from '../helpers/report';
import { attachFailureArtifacts } from '../helpers/failure-artifacts';
import { TripTravelersPage, type TravelerWriteCall, type TravellersApp } from '../pages/trip-travelers.page';
import {
  expectNoNewTravelerInfoEvent,
  isMakePayableDbConfigured,
  resetQueryLog,
  runSqlFile,
  travelerInfoEventsForOffer,
  waitForRemovalEvent,
  waitForServiceRemovalEvent,
  waitForTravelerInfoEvent,
  type TravelerInfoEvent,
} from '../utils/make-payable-db';
import {
  assertPublishedMessageShape,
  isServiceBusConfigured,
  waitForPublishedEvent,
} from '../utils/make-payable-service-bus';

/**
 * TB-271 end-to-end: drive the Travelers tab in the real portal, then verify
 * each of the three layers the event passes through.
 *
 *   1. UI      the click produced the expected POST, and it was accepted
 *   2. Postgres the outgoing handler composed and appended the event, with the
 *               right payload, the right travelerType and a real TripId
 *   3. ASB      the event actually reached the broker with the right Label
 *
 * Layer 3 SKIPS until a QA subscription with a `trip.make-payable.traveler-info`
 * Label filter exists (see traveler/README.md for the two az commands). It is
 * written and wired now so that the day the subscription appears, setting one
 * env var turns it on — nobody has to remember to come back and write it.
 *
 * The event id is what makes this genuinely end-to-end rather than three
 * separate observations: TravelerInfoOutgoingHandler mints one GUID and uses it
 * as BOTH the Marten stream id of the audit append and the `id` field of the
 * published message, so layer 3 looks up exactly the row layer 2 found.
 *
 * REQUIREMENTS
 *   TB271_TRIP_ID  a trip whose offer exists, in the dev environment. These
 *                  tests do not create a trip: that means driving search,
 *                  add-to-quote and the generate-offer wizard, which is a
 *                  different feature's coverage and would make a traveller
 *                  failure indistinguishable from a shopping failure.
 *   TB271_CLIENT_SEARCH  the client to attach (defaults to "Cartman").
 *   plus MAKE_PAYABLE_POSTGRES_URI and the VPN, as for the DB-only spec.
 *
 * Serial and order-dependent by design: the flows build on each other exactly
 * as an advisor would use the page. "Add traveller" is disabled until a client
 * is attached, so the companion and ad-hoc cases cannot precede case 1.
 */

const TRIP_ID = process.env.TB271_TRIP_ID;
const CLIENT_SEARCH = process.env.TB271_CLIENT_SEARCH ?? 'Cartman';
/**
 * Which app to drive. `tsp` is the default because that is where the /trips
 * dashboard actually navigates (/tsp/:tripId/travellers); set TB271_APP=trip to
 * drive the apps/trip workspace instead. Sheet selectors are identical in both.
 */
const APP = (process.env.TB271_APP as TravellersApp | undefined) ?? 'tsp';

test.describe.configure({ mode: 'serial' });

test.describe('TB-271 traveler-info event, driven through the UI', () => {
  test.skip(!isMakePayableDbConfigured(), 'MAKE_PAYABLE_POSTGRES_URI is not set');
  test.skip(
    !TRIP_ID,
    'TB271_TRIP_ID is not set — point it at a dev trip that already has an offer (see traveler/README.md)',
  );

  /** Event ids seen so far, so the negative case can tell new from pre-existing. */
  const seenEventIds: string[] = [];
  /**
   * The offer under test, learned from case 1's POST URL. Shared across tests
   * because the offerId is not rendered anywhere in the UI — the request URL is
   * the only place it appears — and serial mode keeps all four cases in one
   * worker, so a module-level value is safe here.
   */
  let offerUnderTest: string | undefined;
  /**
   * The write this test made, remembered so the afterEach hook can render a
   * curl reproduction. Cleared per test so a failure never shows the previous
   * case's call.
   */
  let lastCall: TravelerWriteCall | undefined;

  test.beforeEach(() => {
    resetQueryLog();
    lastCall = undefined;
  });

  /**
   * On failure this adds the SQL trace, a runnable curl for the make-payable
   * call, and CLI/DBeaver commands for the same offer — on top of the video,
   * screenshot and trace Playwright retains for this project. The browser
   * artifacts show what the advisor saw; these show what the backend did.
   */
  test.afterEach(async ({}, testInfo) => {
    await attachFailureArtifacts(testInfo, {
      call: lastCall,
      offerId: offerUnderTest,
      notes: [
        'Layer 3 (Service Bus) is skipped unless MAKE_PAYABLE_SB_SUBSCRIPTION is set — check the',
        'test annotations for an "asb-skipped" entry before concluding the broker leg was verified.',
      ],
    });
  });

  /**
   * Shared verification for a positive case: the POST was accepted, the event
   * landed in Postgres with the expected type and a non-empty TripId, and — when
   * the QA subscription exists — the same event id turned up on the broker.
   */
  async function verifyAllLayers(
    testInfo: TestInfo,
    call: TravelerWriteCall,
    travelerType: string,
  ): Promise<void> {
    const failures: string[] = [];
    offerUnderTest = call.offerId;

    await testInfo.attach('http-call', {
      body: JSON.stringify(call, null, 2),
      contentType: 'application/json',
    });

    // Layer 1 — the UI actually called make-payable and was accepted. Both codes
    // are real: the docs describe these writes as 202, but the ad-hoc endpoint
    // (`/travellers/new`) was observed returning 200 in dev on 2026-09-10, so
    // pinning this to 202 alone would fail a working flow.
    if (![200, 202].includes(call.status)) {
      failures.push(`ui: ${call.method} ${call.url} returned ${call.status}, expected 200 or 202`);
    }

    // Layer 2 — the event exists in the audit stream.
    const event: TravelerInfoEvent | undefined = await waitForTravelerInfoEvent(call.offerId, travelerType);

    if (!event) {
      const timeline = await runSqlFile('04-offer-timeline-diagnostic.sql', call.offerId);
      await testInfo.attach('offer-timeline-on-failure', {
        body: JSON.stringify(timeline, null, 2),
        contentType: 'application/json',
      });
      failures.push(
        `db: no ${travelerType} traveler-info event on offer ${call.offerId} within 45s. ` +
          'See the attached timeline: a ClientAssignedToOffer row with no traveler-info row means ' +
          'Management published the outbound trigger and Integration.Worker never consumed it.',
      );
      await attachFailures(testInfo, failures);
      expect(failures, failures.join('\n')).toEqual([]);
      return;
    }

    seenEventIds.push(event.event_id);
    await testInfo.attach('audit-event', {
      body: JSON.stringify(event, null, 2),
      contentType: 'application/json',
    });

    if (event.direction !== 'Outgoing') {
      failures.push(`db: event ${event.event_id} has integration-direction "${event.direction}", expected "Outgoing"`);
    }
    // The TODO(TB-271) leak: attaching before the offer has initialised publishes
    // an all-zero TripId that is never corrected. Never observed in dev, so if it
    // shows up here the path has become reachable.
    if (event.trip_id === '00000000-0000-0000-0000-000000000000') {
      failures.push(
        `db: event ${event.event_id} published tripId = 00000000-… — the TODO(TB-271) leak is reachable ` +
          'through this UI path',
      );
    }

    // Layer 3 — the broker. Skipped, not failed, while the subscription is absent.
    if (isServiceBusConfigured()) {
      const { found, outcome } = await waitForPublishedEvent(event.event_id);
      if (!outcome.usable) {
        testInfo.annotations.push({ type: 'asb-skipped', description: outcome.reason ?? 'not usable' });
      } else if (!found) {
        failures.push(
          `asb: event ${event.event_id} was appended to the audit stream but never appeared on the topic. ` +
            'The audit append and the publish share one transaction, so this points at the outbox or the ' +
            "subscription's filter rather than at the handler.",
        );
      } else {
        await testInfo.attach('service-bus-message', {
          body: JSON.stringify({ subject: found.subject, messageId: found.messageId, body: found.body }, null, 2),
          contentType: 'application/json',
        });
        failures.push(
          ...assertPublishedMessageShape(found, {
            eventId: event.event_id,
            offerId: call.offerId,
            travelerType,
          }),
        );
      }
    } else {
      testInfo.annotations.push({
        type: 'asb-skipped',
        description: 'MAKE_PAYABLE_SB_SUBSCRIPTION not set — broker leg unverified (see traveler/README.md)',
      });
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  }

  test('case 1 — attaching an existing client with "Is travelling" ON fires a Client event', async ({ page }, testInfo) => {
    const travelers = new TripTravelersPage(page, APP);
    await travelers.goto(TRIP_ID!);

    // Record what already exists so the negative case later can tell new events
    // from historical ones on the same offer.
    const call = lastCall = await travelers.attachExistingClient(CLIENT_SEARCH, { isTravelling: true });
    for (const event of await travelerInfoEventsForOffer(call.offerId)) {
      if (!seenEventIds.includes(event.event_id)) seenEventIds.push(event.event_id);
    }

    await verifyAllLayers(testInfo, call, 'Client');
  });

  test('case 2 — adding a saved companion fires a Companion event', async ({ page }, testInfo) => {
    const travelers = new TripTravelersPage(page, APP);
    await travelers.goto(TRIP_ID!);

    const call = lastCall = await travelers.addFirstSavedCompanion();
    // The dev clients currently have companions: [] — skip rather than fail, and
    // say why, so an empty fixture never masquerades as a product defect.
    test.skip(call === null, 'the attached client has no saved companions in this environment');

    await verifyAllLayers(testInfo, call!, 'Companion');
  });

  test('case 3 — adding an ad-hoc traveller fires an AdhocTraveller event', async ({ page }, testInfo) => {
    const travelers = new TripTravelersPage(page, APP);
    await travelers.goto(TRIP_ID!);

    const stamp = Date.now().toString().slice(-6);
    const call = lastCall = await travelers.addAdhocTraveller({
      firstName: 'E2E',
      lastName: `Adhoc${stamp}`,
      phone: '02071234567',
    });

    await verifyAllLayers(testInfo, call, 'AdhocTraveller');
  });

  /**
   * The one check nothing else can make. Every other test would still pass if
   * the trigger fired on every code path, including the ones where the client is
   * linked to the offer but deliberately NOT travelling.
   */
  test('case 4 — NEGATIVE: turning "Is travelling" off must not fire any event', async ({ page }, testInfo) => {
    test.setTimeout(180_000); // the assertion is a deliberate 30s quiet window

    const travelers = new TripTravelersPage(page, APP);
    await travelers.goto(TRIP_ID!);

    const ids = await travelers.rosterTravelerIds();
    const toggleOfferId = travelers.offerId() ?? offerUnderTest;
    console.log(`[case 4] offer=${toggleOfferId} roster=${ids.length}`);
    test.skip(ids.length === 0, 'roster is empty — attach a client first');
    test.skip(!toggleOfferId, 'could not resolve the offerId from the page traffic');
    offerUnderTest = toggleOfferId;

    // Snapshot BEFORE acting. The assertion is "no NEW event", not "no events":
    // this offer legitimately carries the events cases 1–3 just produced.
    const before = await travelerInfoEventsForOffer(offerUnderTest!);
    const knownIds = [...new Set([...seenEventIds, ...before.map((event) => event.event_id)])];
    await testInfo.attach('known-event-ids-before-toggle', {
      body: knownIds.join('\n') || '(none)',
      contentType: 'text/plain',
    });

    const call = lastCall = await travelers.turnOffIsTravelling(ids[0]);
    await testInfo.attach('http-call', {
      body: JSON.stringify(call, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];
    if (![200, 202, 204].includes(call.status)) {
      failures.push(`ui: ${call.method} ${call.url} returned ${call.status}`);
    }

    // Waits out the full window rather than querying once — an "expect nothing"
    // check that returns immediately would pass while the event was still in
    // flight, which is precisely the bug it exists to catch.
    failures.push(
      ...(await safeDbCheck('expectNoNewTravelerInfoEvent', () =>
        expectNoNewTravelerInfoEvent(offerUnderTest!, knownIds),
      )),
    );

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  /**
   * The Remove button — a genuinely different path from case 4's toggle, and one
   * with BOTH a positive and a negative assertion:
   *   positive: TravelerRemovedIntegrationEvent must fire
   *   negative: no NEW traveler-info event (traveler-info is attach-only)
   *
   * Remove is disabled for the client row, so this exercises the companion /
   * ad-hoc path. It also cleans up whatever case 3 added, which keeps repeated
   * runs from piling test travellers onto the trip.
   */
  test('case 6 — removing a traveller fires TravelerRemoved and NO traveler-info event', async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const travelers = new TripTravelersPage(page, APP);
    await travelers.goto(TRIP_ID!);

    const removable = await travelers.removableTravelerIds();
    const rosterIds = await travelers.rosterTravelerIds();
    // Logged, not silent: a skip with no explanation is indistinguishable from a
    // pass at a glance, and these two numbers say immediately whether the roster
    // was empty or simply had nothing removable on it.
    console.log(
      `[case 6] offer=${travelers.offerId() ?? offerUnderTest} roster=${rosterIds.length} removable=${removable.length}`,
    );
    test.skip(
      removable.length === 0,
      `no removable traveller (roster has ${rosterIds.length} row(s); Remove is disabled for the client) — run case 3 first`,
    );

    const offerId = travelers.offerId() ?? offerUnderTest;
    test.skip(!offerId, 'could not resolve the offerId from the page traffic');

    const travelerId = removable[removable.length - 1];
    const before = await travelerInfoEventsForOffer(offerId!);
    const knownIds = [...new Set([...seenEventIds, ...before.map((event) => event.event_id)])];

    const call = lastCall = await travelers.removeTraveller(travelerId);
    offerUnderTest = call.offerId;

    await testInfo.attach('http-call', {
      body: JSON.stringify(call, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];
    if (call.method !== 'DELETE') {
      failures.push(`ui: expected a DELETE for removal, got ${call.method} ${call.url}`);
    }
    if (![200, 202, 204].includes(call.status)) {
      failures.push(`ui: ${call.method} ${call.url} returned ${call.status}`);
    }

    // Positive half.
    const removalEvents = await waitForRemovalEvent(call.offerId, travelerId);
    await testInfo.attach('removal-events', {
      body: JSON.stringify(removalEvents, null, 2),
      contentType: 'application/json',
    });
    if (removalEvents.length === 0) {
      failures.push(
        `db: no TravelerRemovedIntegrationEvent for traveller ${travelerId} on offer ${call.offerId} within 45s`,
      );
    }
    for (const event of removalEvents) {
      if (event.direction !== 'Outgoing') {
        failures.push(`db: ${event.event_type} has integration-direction "${event.direction}", expected "Outgoing"`);
      }
    }

    // Negative half — removal must not publish traveler identity again.
    failures.push(
      ...(await safeDbCheck('expectNoNewTravelerInfoEvent', () =>
        expectNoNewTravelerInfoEvent(call.offerId, knownIds),
      )),
    );

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  /**
   * The service-level removal path, modelled on a real session's HAR
   * (offer 4de437b6-…, 2026-09-10). One traveller, four steps, and each step
   * has a different event signature:
   *
   *   create + assign all   TravelerInfo + TravelerAssignedToServices   (one "Done")
   *   untick ONE cell       TravelerRemovedFromService, serviceId POPULATED
   *   remove the traveller  TravelerRemovedFromServices (serviceId null) + TravelerRemoved
   *
   * Why it needs its own case rather than extending case 6: a traveller with no
   * assignments produces only `TravelerRemoved`, so case 6 can never exercise
   * the service-level events at all — which is exactly the gap this fills.
   *
   * Throughout, no further traveler-info event may appear: identity is published
   * on attach only, never on assignment or removal.
   */
  test('case 7 — assigning then removing a service fires the service-level events, and no traveler-info', async ({ page }, testInfo) => {
    test.setTimeout(240_000);

    const travelers = new TripTravelersPage(page, APP);
    await travelers.goto(TRIP_ID!);

    const stamp = Date.now().toString().slice(-6);
    const firstName = 'E2ESvc';
    const call = (lastCall = await travelers.addAdhocTraveller({
      firstName,
      lastName: `Removal${stamp}`,
      phone: '02071234567',
      assignAllServices: true,
    }));
    offerUnderTest = call.offerId;

    const failures: string[] = [];
    await testInfo.attach('create-call', {
      body: JSON.stringify(call, null, 2),
      contentType: 'application/json',
    });

    // The traveller id comes back in the create response — the roster row's
    // data-traveler-id would do too, but the response is authoritative and
    // avoids racing the optimistic row against the backoff poll.
    const travelerId = (call.responseBody as { travellerId?: string } | null)?.travellerId;
    if (!travelerId) {
      failures.push(`ui: create response carried no travellerId: ${JSON.stringify(call.responseBody)}`);
      await attachFailures(testInfo, failures);
      expect(failures, failures.join('\n')).toEqual([]);
      return;
    }

    const infoEvent = await waitForTravelerInfoEvent(call.offerId, 'AdhocTraveller');
    if (infoEvent) seenEventIds.push(infoEvent.event_id);

    const assigned = await travelers.assignedServiceLabels(firstName);
    const matrixLabels = await travelers.matrixCellLabels();
    await testInfo.attach('assigned-services', {
      body: [
        `checked cells for "${firstName}": ${assigned.length}`,
        ...assigned.map((label) => `  ${label}`),
        '',
        `every matrix cell aria-label found (${matrixLabels.length}):`,
        ...matrixLabels.map((label) => `  ${label}`),
      ].join('\n'),
      contentType: 'text/plain',
    });
    // Both numbers, because "no services assigned" has two very different
    // causes: the trip has no assignable services (a fixture problem), or the
    // cells exist but this traveller's are unchecked (Assign all did not take).
    console.log(`[case 7] traveler=${travelerId} checked=${assigned.length} matrixCells=${matrixLabels.length}`);
    test.skip(
      assigned.length === 0,
      `no services assigned to "${firstName}" — the matrix exposed ${matrixLabels.length} cell(s) in total, ` +
        'so either the trip has no assignable services or "Assign all" did not apply',
    );

    // Snapshot before the removals so the negative half is "no NEW event".
    const before = await travelerInfoEventsForOffer(call.offerId);
    const knownIds = [...new Set([...seenEventIds, ...before.map((event) => event.event_id)])];

    // ── Step 1: remove ONE service ─────────────────────────────────────────
    const serviceRemoval = (lastCall = await travelers.removeServiceFromTraveller(firstName, assigned[0]));
    await testInfo.attach('service-removal-call', {
      body: JSON.stringify(serviceRemoval, null, 2),
      contentType: 'application/json',
    });

    const serviceId = /\/services\/([0-9a-f-]{36})\//i.exec(serviceRemoval.url)?.[1];
    const singleEvent = await waitForServiceRemovalEvent(call.offerId, travelerId, serviceId);
    await testInfo.attach('service-removal-event', {
      body: JSON.stringify(singleEvent ?? null, null, 2),
      contentType: 'application/json',
    });

    if (!singleEvent) {
      failures.push(
        `db: no TravelerRemovedFromServiceIntegrationEvent (with a populated serviceId) for traveller ` +
          `${travelerId} / service ${serviceId} on offer ${call.offerId} within 45s`,
      );
    } else if (singleEvent.service_id !== serviceId) {
      failures.push(
        `db: service-removal event carries serviceId "${singleEvent.service_id}", but the UI removed "${serviceId}"`,
      );
    }

    // ── Step 2: remove the traveller entirely ──────────────────────────────
    const travelerRemoval = (lastCall = await travelers.removeTraveller(travelerId));
    await testInfo.attach('traveler-removal-call', {
      body: JSON.stringify(travelerRemoval, null, 2),
      contentType: 'application/json',
    });

    const removalEvents = await waitForRemovalEvent(call.offerId, travelerId);
    await testInfo.attach('traveler-removal-events', {
      body: JSON.stringify(removalEvents, null, 2),
      contentType: 'application/json',
    });

    const types = removalEvents.map((event) => event.event_type);
    if (!types.some((type) => type.startsWith('TravelerRemovedIntegrationEvent'))) {
      failures.push(`db: no TravelerRemovedIntegrationEvent for traveller ${travelerId}`);
    }
    // This traveller HAD assignments left after step 1, so the batched event is
    // required here — unlike case 6, where a traveller with none legitimately
    // produces only TravelerRemoved.
    if (!types.some((type) => type.startsWith('TravelerRemovedFromServicesIntegrationEvent'))) {
      failures.push(
        `db: no batched TravelerRemovedFromServicesIntegrationEvent for traveller ${travelerId}, ` +
          `which still had ${assigned.length - 1} assignment(s) when it was removed`,
      );
    }

    // ── Negative half: identity must not be republished ────────────────────
    failures.push(
      ...(await safeDbCheck('expectNoNewTravelerInfoEvent', () =>
        expectNoNewTravelerInfoEvent(call.offerId, knownIds),
      )),
    );

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  /**
   * The other half of the negative case: attaching a client who is NOT
   * travelling, rather than un-travelling one who already is. It needs its own
   * trip, because a client is locked to an offer once attached — case 1 has
   * already claimed the trip above — so it is gated on a second env var and
   * skips by default.
   */
  test('case 5 — NEGATIVE: attaching a client with "Is travelling" OFF must not fire an event', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const freshTripId = process.env.TB271_FRESH_TRIP_ID;
    test.skip(
      !freshTripId,
      'TB271_FRESH_TRIP_ID is not set — needs a trip with an offer and NO client attached yet',
    );

    const travelers = new TripTravelersPage(page, APP);
    await travelers.goto(freshTripId!);

    const call = lastCall = await travelers.attachExistingClient(CLIENT_SEARCH, { isTravelling: false });
    const before = await travelerInfoEventsForOffer(call.offerId);

    await testInfo.attach('http-call', {
      body: JSON.stringify(call, null, 2),
      contentType: 'application/json',
    });

    const failures: string[] = [];

    // ClientAssignedToOffer SHOULD fire here — the client is linked, just not
    // pooled. Its absence would mean the attach silently did nothing, which
    // would make the "no traveler-info event" result meaningless.
    const timeline = (await runSqlFile<{ event_type: string }>('04-offer-timeline-diagnostic.sql', call.offerId)).map(
      (row) => row.event_type,
    );
    await testInfo.attach('offer-timeline', { body: timeline.join('\n'), contentType: 'text/plain' });
    if (!timeline.some((type) => type.includes('ClientAssignedToOffer'))) {
      failures.push(
        `db: no ClientAssignedToOffer event on offer ${call.offerId} — the attach did not take, so ` +
          '"no traveler-info event" proves nothing here',
      );
    }

    failures.push(
      ...(await safeDbCheck('expectNoNewTravelerInfoEvent', () =>
        expectNoNewTravelerInfoEvent(call.offerId, before.map((event) => event.event_id)),
      )),
    );

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
