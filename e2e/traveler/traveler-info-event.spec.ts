import { test, expect } from '@playwright/test';
import { annotateXray, attachFailures, safeDbCheck } from '../helpers/report';
import { attachFailureArtifacts } from '../helpers/failure-artifacts';
import {
  assertNoDuplicatePublishes,
  assertNoEmptyTripIds,
  assertOutgoingHeaderStamped,
  assertPayloadMatchesReadModel,
  assertSessionIsReadOnly,
  isMakePayableDbConfigured,
  resetQueryLog,
  runSqlFile,
  type EventFiringRow,
  type DuplicateRow,
  type TimelineRow,
} from '../utils/make-payable-db';

/**
 * TB-271 — outbound `TravelerInfoIntegrationEvent` coverage.
 * https://traveledgelab.atlassian.net/browse/TB-271
 *
 * The event fires when a traveler is ATTACHED TO AN OFFER — not when a
 * traveler is assigned to a service (that is TravelerAssignedToService…, a
 * different event). Five UI actions trigger it, all landing in one of three
 * Management handlers:
 *
 *   POST {orchestration}/offers/{offerId}/client/existing        -> Client
 *   POST {orchestration}/offers/{offerId}/client/new             -> Client (cascades)
 *   POST {orchestration}/offers/{offerId}/companions/existing    -> Companion
 *   POST {orchestration}/offers/{offerId}/travellers/new-companion -> Companion (cascades)
 *   POST {management}/offers/{offerId}/travellers/new            -> AdhocTraveller
 *
 * Chain under test: Management publishes TravelerInfoOutboundRequested (raw
 * data, durable outbox) -> Integration.Worker's TravelerInfoOutgoingHandler
 * mints the event id, appends it to integration_schema with header
 * integration-direction = Outgoing, then publishes it to the external
 * trip.make-payable topic with Label trip.make-payable.traveler-info.
 *
 * SCOPE AND ITS LIMIT: these checks verify the chain up to and including the
 * audit append. They do NOT verify the broker hop, because no subscription on
 * the dev trip.make-payable topic filters on that Label, so an unmatched
 * message is discarded at publish time and is unobservable. Covering it needs
 * a QA subscription (`sys.Label = 'trip.make-payable.traveler-info'`, no
 * consumer attached) — see traveler/README.md. Do not read a green run here
 * as end-to-end delivery.
 *
 * These are population-level invariants over every event dev has accumulated,
 * rather than one scripted attach. That is deliberate: it turns other people's
 * manual testing into regression coverage, and it means a run is meaningful
 * even when nobody has clicked anything today. The offer-scoped checks
 * (assertPayloadMatchesReadModel, assertEventFiredForOffer) are there for the
 * UI-driven test described at the bottom of this file.
 *
 * Every query lives in traveler/sql/*.sql and is shared verbatim with DBeaver
 * and the standalone tb-271-verify CLI — one source of truth, so a query can
 * never pass here while a stale copy misleads someone reading the ticket.
 *
 * Requires MAKE_PAYABLE_POSTGRES_URI (see .env.example) and the corporate VPN:
 * the server is behind a private endpoint. Skips as a whole when unset, the
 * same way the PIM ground-truth checks do.
 */

const EXPECTED_TRAVELER_TYPES = ['Client', 'Companion', 'AdhocTraveller'] as const;

test.describe('TB-271 traveler-info integration event', () => {
  test.skip(
    !isMakePayableDbConfigured(),
    'MAKE_PAYABLE_POSTGRES_URI is not set — skipping make-payable DB ground-truth checks',
  );

  // Per-test query trace: reset before, attached on failure. There is no browser
  // here, so this SQL trace IS the failure evidence — it shows the exact
  // statement and parameters behind an "expected an event, found none".
  test.beforeEach(() => resetQueryLog());
  test.afterEach(async ({}, testInfo) => attachFailureArtifacts(testInfo));

  // Runs first by position: if the safety net is gone, that is worth knowing
  // before the rest of the suite touches the database at all.
  test('connects read-only, so the suite cannot mutate dev', async ({}, testInfo) => {
    const failures = await safeDbCheck('assertSessionIsReadOnly', assertSessionIsReadOnly);
    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('fires for every traveler type, and never leaks an empty TripId', async ({}, testInfo) => {
    annotateXray(testInfo, process.env.XRAY_TB271_TRIPID);

    const rows = await runSqlFile<EventFiringRow>('01-is-the-event-firing.sql');
    await testInfo.attach('event-counts-by-type', {
      body: JSON.stringify(rows, null, 2),
      contentType: 'application/json',
    });

    const failures = await safeDbCheck('assertNoEmptyTripIds', assertNoEmptyTripIds);

    // A type that has never fired is a coverage gap, not necessarily a code
    // defect — report it as a failure so it cannot be mistaken for a pass, but
    // name it distinctly from the TripId leak above.
    const seen = new Set(rows.map((row) => row.traveler_type));
    for (const type of EXPECTED_TRAVELER_TYPES) {
      if (!seen.has(type)) {
        failures.push(`coverage: no ${type} event has ever been recorded — this variant is untested in this environment`);
      }
    }

    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('stamps every outbound event with integration-direction = Outgoing', async ({}, testInfo) => {
    annotateXray(testInfo, process.env.XRAY_TB271_HEADER);

    const failures = await safeDbCheck('assertOutgoingHeaderStamped', assertOutgoingHeaderStamped);
    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('never publishes the same event twice for one command', async ({}, testInfo) => {
    annotateXray(testInfo, process.env.XRAY_TB271_DUPLICATES);

    const rows = await runSqlFile<DuplicateRow>('06-duplicates-real-or-not.sql');
    // Attached even when passing: repeats ARE expected here (attach, remove,
    // re-attach), so the artifact shows a reviewer what was inspected and why
    // it was judged legitimate — events == distinct_causations.
    await testInfo.attach('repeat-events-by-offer-traveler', {
      body: JSON.stringify(rows, null, 2),
      contentType: 'application/json',
    });

    const failures = await safeDbCheck('assertNoDuplicatePublishes', assertNoDuplicatePublishes);
    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  /**
   * Payload correctness on the most recently touched offer. An event that
   * exists but carries the wrong name/email is still a defect, and event-count
   * assertions alone would never catch it.
   */
  test('payload matches the client read model on the most recent offer', async ({}, testInfo) => {
    annotateXray(testInfo, process.env.XRAY_TB271_PAYLOAD);

    // TB271_OFFER_ID pins the check to one offer — set it after driving the UI
    // by hand. Unset, it falls back to whichever offer most recently produced
    // an event, so a plain run still asserts something real.
    const offerId =
      process.env.TB271_OFFER_ID ??
      (await runSqlFile<{ offer_id: string }>('09-most-recent-offer.sql'))[0]?.offer_id;

    test.skip(!offerId, 'no traveler-info events exist yet, so there is no offer to compare');

    const timeline = await runSqlFile<TimelineRow>('04-offer-timeline-diagnostic.sql', offerId);
    await testInfo.attach(`offer-${offerId}-timeline`, {
      body: JSON.stringify(timeline, null, 2),
      contentType: 'application/json',
    });

    const failures = await safeDbCheck('assertPayloadMatchesReadModel', () => assertPayloadMatchesReadModel(offerId!));
    await attachFailures(testInfo, failures);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

/**
 * NOT YET WRITTEN — the UI-driven leg.
 *
 * Everything above is a DB invariant, so it cannot catch "the button no longer
 * triggers anything". The missing test drives the portal, captures the offerId
 * from the POST, then asserts with assertEventFiredForOffer(offerId, [...]):
 *
 *   1. attach an existing client with "Is Travelling" ON   -> expect a Client event
 *   2. add a companion                                     -> expect a Companion event
 *   3. add an ad-hoc traveler                              -> expect an AdhocTraveller event
 *   4. NEGATIVE: attach a client with "Is Travelling" OFF  -> expect ClientAssignedToOffer
 *      and NO traveler-info event (08-over-firing-is-travelling-off.sql). This is the only
 *      check that catches the trigger over-firing, and it is currently unverified in dev —
 *      no historical OFF case exists in the data.
 *
 * It needs a Trip-workspace page object (this suite's pages/ only covers
 * landing and search) plus a seeded offer, which is why it is not here yet.
 */
